const { Console } = require('console');
const MediaRendererClient = require('upnp-mediarenderer-client');
const { execFile, spawn } = require('child_process');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const net = require('net');
const os = require('os');

// TODO: Ideally the author will accept the pull request and re-publish. Otherwise tie it to my fork.
const Ytcr = require('yt-cast-receiver');

// YouTube senders expect the DIAL app state to name the screenId they paired
// with. The pinned receiver exposes screenId but does not publish it through
// peer-dial's additionalData hook, so the sender sees a running app without
// its screenId and treats the app as stopped.
const YouTubeApp = require('yt-cast-receiver/lib/app');
if (!Object.getOwnPropertyDescriptor(YouTubeApp.prototype, 'additionalData')) {
    Object.defineProperty(YouTubeApp.prototype, 'additionalData', {
        get: function() {
            console.log(`[${this.screenName}]: DIAL screenId ${this.screenId || '(none)'}`);
            return this.screenId ? { screenId: this.screenId } : undefined;
        }
    });
}

// The pinned receiver advertises the same lounge device ID on every host.
// YouTube's lounge then has two screens with one identity, and the sender can
// drop the session after a few seconds. Derive a stable valid UUID per host.
const announcementId = crypto.createHash('sha1').update(os.hostname()).digest('hex');
const SCREEN_UID = [
    announcementId.slice(0, 8),
    announcementId.slice(8, 12),
    '5' + announcementId.slice(13, 16),
    '8' + announcementId.slice(17, 20),
    announcementId.slice(20, 32)
].join('-');
const getAnnouncementTemplate = YouTubeApp.prototype._getAnnouncementTemplate;
YouTubeApp.prototype._getAnnouncementTemplate = function() {
    const template = getAnnouncementTemplate.call(this);
    template.id = SCREEN_UID;
    return template;
};

// Use ports 3000, 3001, 3002 etc for successive YTCRs
const YTCR_BASE_PORT = 3000;

// Use port 800n for the HTTPS->HTTP proxying of the media
const PROXY_BASE_PORT = 8000;

// How often the media proxy follows a redirect from googlevideo before it
// gives up on one attempt (the chains are routinely two to three hops long),
// how many fresh URLs it resolves in total, how long it waits between them,
// how often and how long it retries a URL that is not yet valid at the edge,
// how long it waits for an edge to answer, and how long it tolerates silence
// while the stream is running.
const MAX_MEDIA_REDIRECTS = 8;
const MAX_MEDIA_ATTEMPTS = 3;
const MEDIA_RETRY_DELAY = 500;
const MEDIA_URL_SETTLE_ATTEMPTS = 5;
const MEDIA_URL_SETTLE_DELAY = 500;
const MEDIA_CONNECT_TIMEOUT = 10000;
const MEDIA_IDLE_TIMEOUT = 15000;

// googlevideo signs its URLs for the client address that requested them.
// Resolve the initial URL over IPv4, which is available on every LAN and does
// not depend on the host's IPv6 routing; the retry path falls back to IPv6.
const PREFERRED_MEDIA_ADDRESS_FAMILY = 4;

/**
 * Convert a dotted IPv4 address to an unsigned 32-bit integer.
 */
function ipv4ToInt(address) {
    return address.split('.').reduce((result, octet) => ((result << 8) + Number(octet)) >>> 0, 0);
}

/**
 * Find the local IPv4 address that is in the same subnet as the remote host.
 * Renderers must be able to reach the proxy, so URLs cannot use os.hostname(),
 * which usually only resolves on this machine itself.
 */
function localAddressFor(remoteHost) {
    const target = net.isIPv4(remoteHost) ? ipv4ToInt(remoteHost) : null;
    var fallback = null;

    for (const addresses of Object.values(os.networkInterfaces())) {
        for (const address of addresses || []) {
            if (address.family !== 'IPv4' || address.internal) continue;

            if (fallback === null) fallback = address.address;

            if (target !== null) {
                const mask = ipv4ToInt(address.netmask);
                if ((target & mask) === (ipv4ToInt(address.address) & mask)) {
                    return address.address;
                }
            }
        }
    }

    return fallback;
}

/**
 * Address family to connect with for a signed googlevideo URL.
 * googlevideo URLs are locked to the IP address that requested them, so we
 * must use the same address family (IPv4 or IPv6) that yt-dlp used.
 * Returns 0 when the URL carries no IP.
 */
function addressFamilyOf(url) {
    const signedIp = url.searchParams.get('ip');
    return net.isIPv4(signedIp) ? 4 : net.isIPv6(signedIp) ? 6 : 0;
}

/**
 * Whether an IP address belongs to one of this host's interfaces.
 * An IPv4 media URL names the public NAT address, which is not local; an IPv6
 * URL normally names the address itself, so we can bind to it.
 */
function isLocalAddress(candidate) {
    for (const addresses of Object.values(os.networkInterfaces())) {
        for (const address of addresses || []) {
            if (address.address === candidate) return true;
        }
    }

    return false;
}

/**
 * Fetch a signed googlevideo URL and follow its redirects.
 *
 * `hops` collects "status@host" entries so a failure can name the server that
 * rejected the request. The callback gets either an error or a readable
 * upstream response.
 */
function followMediaRedirects(url, family, hops, redirectsLeft, callback, settleAttemptsLeft = MEDIA_URL_SETTLE_ATTEMPTS, originalUrl = null) {
    // Redirect targets can point at an edge that rejects the URL outright.
    // Retrying the URL that yt-dlp signed lets the load balancer pick another
    // edge, while still following a target that happens to be usable.
    const retryUrl = originalUrl || url;

    const options = {
        headers: { range: 'bytes=0-' },
        timeout: MEDIA_CONNECT_TIMEOUT
    };

    // Redirect targets may lose the `ip` parameter, but they are still bound
    // to the family of the URL that was signed. Carry it through the chain.
    family = family || addressFamilyOf(url);
    if (family) options.family = family;

    // googlevideo rejects a signed URL when it is fetched from another address
    // than the one in its `ip` parameter.
    const signedIp = url.searchParams.get('ip');
    if (signedIp && isLocalAddress(signedIp)) options.localAddress = signedIp;

    // Redirect targets are still https in practice, but honour the scheme.
    const client = url.protocol === 'http:' ? http : https;

    // A destroy() fires 'error' as well, and a response error after we already
    // handed the stream out must not call the callback a second time.
    let settled = false;
    const finish = function(err, response) {
        if (settled) return;
        settled = true;
        callback(err, response);
    };

    const request = client.get(url, options, function(response) {
        const status = response.statusCode;
        const location = response.headers.location;
        const hop = `${status}@${url.hostname}`;
        if (hops[hops.length - 1] !== hop) hops.push(hop);

        if (status >= 300 && status < 400 && location) {
            response.resume();

            if (redirectsLeft <= 0) {
                finish(new Error(`redirected too often (${hops.join(' ')})`));
                return;
            }

            followMediaRedirects(new URL(location, url), family, hops, redirectsLeft - 1, finish, settleAttemptsLeft, retryUrl);
            return;
        }

        if (status !== 200 && status !== 206) {
            // googlevideo explains rejects in the body; keep a short excerpt.
            let body = '';
            const fail = function() {
                // A signed URL answers 403 until it reaches the serving edge,
                // and 503 while that edge is not ready. Retry the original URL:
                // a redirect target can be a permanently rejected edge while
                // the original URL becomes usable.
                if ((status === 403 || status === 503) && settleAttemptsLeft > 1) {
                    if (settled) return;
                    settled = true;

                    setTimeout(function() {
                        followMediaRedirects(retryUrl, family, hops, redirectsLeft, callback, settleAttemptsLeft - 1, retryUrl);
                    }, MEDIA_URL_SETTLE_DELAY);
                    return;
                }

                const detail = body.replace(/\s+/g, ' ').slice(0, 200);
                finish(new Error(`media server returned ${status} (${hops.join(' ')})${detail ? ': ' + detail : ''}`));
            };

            response.setEncoding('utf8');
            response.on('data', function(chunk) {
                if (body.length < 200) body += chunk;
            });
            response.on('end', fail);
            response.on('error', fail);
            return;
        }

        // The body is consumed by the caller, which applies its own idle
        // timeout. The socket timeout must not fire while it streams.
        request.setTimeout(0);
        finish(null, response);
    });

    request.on('timeout', function() {
        const trail = hops.length ? ` (${hops.join(' ')})` : '';
        request.destroy(new Error(`no answer from ${url.hostname} within ${MEDIA_CONNECT_TIMEOUT}ms${trail}`));
    });

    request.on('error', finish);
}

// TODO Does this clean up nicely? YTCR instance disappear from the menu in the youtube app? Port freed etc?

/**
 * Class controlling a single upnp media renderer.
 * It implements yt-cast-receiver.Player so that it can receive and translate casts from YouTube.
 */
class Renderer extends Ytcr.Player {

    constructor(location, index, timeout)
    {
        // Call the Ytcr.Player constructor
        super();

        console.log("Creating new renderer: " + location);
        this.location = location;
        this.index = index;
        this.timeout = timeout;
        this.httpServer = null;
        this.stream = null;
        this.playGeneration = 0;
        this.streamServer = null;
        this.refresh();

        // Instantiate the mediarender client
        this.client = new MediaRendererClient(location);

        // No errors so far
        this.error = false

        // Get device details
        const obj = this;
        this.client.getDeviceDescription(function(err, description) {
            if (err) {
                console.log("Failed to get device description from " + obj.location);
                return;
            }

            // Create a friendly string from the above, which we will name the YouTube cast receiver
            // e.g. "Living Room (Pure Jongo A2)"
            const friendlyName = description.friendlyName;
            const manufacturer = description.manufacturer;
            const modelName = description.modelName;
            obj.friendlyName = `🔊 ${friendlyName} (${manufacturer} ${modelName})`;
            console.log(`[${obj.friendlyName}]: New renderer created, timeout ${obj.timeout}`);

            // TODO Select audio or video according to the capabilities of the renderer
            // obj.client.getSupportedProtocols( function(error, protocols) {
            //     if(err) {
            //         console.log(`[${obj.friendlyName}]: getSupportedProtocols error:`);
            //         console.log(err);
            //     } else {
            //         console.log(`[${obj.friendlyName}]: getSupportedProtocols:`);
            //         console.log(protocols);
            //     }
            // });

            // Create a youtube cast receiver
            const dialAddress = localAddressFor(new URL(obj.location).hostname);
            const options = {port: YTCR_BASE_PORT + obj.index,
                             friendlyName: obj.friendlyName,
                             manufacturer: description.manufacturer,
                             modelName: description.modelName,
                             bindToAddresses: dialAddress ? [dialAddress] : undefined}; 
            obj.ytcr = Ytcr.instance(obj, options);
            obj.ytcr.start();

            obj.ytcr.setDebug(true);
            obj.ytcr.on('connected', client => {
                console.log(`Connected to ${client.name}`);
                console.log(`${client}`);
            });
        });
    }

    refresh() {
        this.lastSeenTime = Number(process.hrtime.bigint() / 1000000000n);
        console.log("Refreshed renderer " + this.location + " to " + this.lastSeenTime);
    }

    isStale() {
        // If an error occurred in setup, we are stale. The program will delete us and recreate.e
        if (this.error) return true;

        // If we have not been refreshed (i.e. discovered again) in this.timeout, we are stale.
        const now = Number(process.hrtime.bigint()  / 1000000000n);
        if (this.lastSeenTime + this.timeout < now) return true;

        return false;
    }

    /**
     * Resolve the audio URL of a video with yt-dlp.
     *
     * `family` is 4 or 6 to sign the URL for that address family, or 0 to let
     * yt-dlp choose. The callback always fires: with the URL, or with null
     * when both tools failed.
     */
    getAudioUrl(videoId, family, callback) {
        const obj = this;
        const args = ['-f', 'bestaudio[ext=m4a]', '--get-url'];
        if (family === 4) args.unshift('-4');
        else if (family === 6) args.unshift('-6');
        args.push(`https://www.youtube.com/watch?v=${videoId}`);

        const report = function(audioUrl) {
            console.log(`[${obj.friendlyName}]: Media URL: ${audioUrl}`);
            callback(audioUrl);
        };

        const fallback = function() {
            // An explicitly requested family may be unavailable on this host;
            // let yt-dlp choose before giving up.
            if (family) {
                obj.getAudioUrl(videoId, 0, callback);
            } else {
                callback(null);
            }
        };

        execFile('yt-dlp', args, function(err, stdout) {
            const audioUrl = stdout.toString().trim();
            if (!err && audioUrl) {
                report(audioUrl);
                return;
            }

            console.log(`[${obj.friendlyName}]: Unable to get audio URL using yt-dlp. Using youtube-dl but this is slower!`);
            execFile('youtube-dl', args, function(err, stdout) {
                const audioUrl = stdout.toString().trim();
                if (!err && audioUrl) {
                    report(audioUrl);
                } else {
                    console.log(`[${obj.friendlyName}]: Error getting URL from youtube-dl`);
                    fallback();
                }
            });
        });
    }

    /**
     * Open the media stream for the current track.
     *
     * googlevideo answers with a redirect to a freshly signed URL on another
     * edge server, and an edge that does not carry the stream answers 403.
     * A signed URL is also rejected until it reaches the serving edge: 403
     * until it is accepted, 503 while that edge is not ready. followMediaRedirects
     * retries those statuses a few times before the URL is abandoned. A
     * rejected redirect target sends the retry back to the original URL, so a
     * dead target does not pin the request to one edge. If that still fails,
     * resolve a fresh URL with yt-dlp, switching between IPv4 and IPv6 so a
     * broken or rejected address family does not block playback.
     */
    openStream(attemptsLeft, callback) {
        const obj = this;
        const stream = this.stream;
        const started = Date.now();

        console.log(`[${obj.friendlyName}]: Opening upstream ${stream.url.hostname}`);

        followMediaRedirects(stream.url, 0, [], MAX_MEDIA_REDIRECTS, function(err, response) {
            if (!err) {
                console.log(`[${obj.friendlyName}]: Upstream open after ${Date.now() - started}ms`);
                callback(null, response);
                return;
            }

            if (attemptsLeft <= 1) {
                callback(err);
                return;
            }

            console.log(`[${obj.friendlyName}]: Media attempt failed: ${err.message}. Resolving a fresh URL...`);

            setTimeout(function() {
                if (obj.stream !== stream) {
                    callback(new Error('track changed while resolving a fresh URL'));
                    return;
                }

                const retryFamily = addressFamilyOf(stream.url) === 6 ? 4 : 6;
                obj.getAudioUrl(stream.videoId, retryFamily, function(audioUrl) {
                    if (!audioUrl) {
                        callback(new Error('unable to resolve a fresh audio URL'));
                        return;
                    }

                    stream.url = new URL(audioUrl);
                    obj.openStream(attemptsLeft - 1, callback);
                });
            }, MEDIA_RETRY_DELAY);
        });
    }

    /**
     * Create the HTTP server that serves the audio stream to the renderer.
     * It is reused for every track.
     */
    ensureStreamServer() {
        if (this.streamServer) return;

        const obj = this;
        this.streamServer = http.createServer(function(req, res) {
            obj.serveStream(req, res);
        });
        this.streamServer.on('error', function(err) {
            console.log(`[${obj.friendlyName}]: Stream server error: ${err.message}`);
        });
        this.streamServer.on('listening', function() {
            console.log(`[${obj.friendlyName}]: Stream server listening on port ${PROXY_BASE_PORT + obj.index}`);
        });
        this.streamServer.listen(PROXY_BASE_PORT + this.index);
    }

    /**
     * Serve the current track to the renderer.
     *
     * Renderers such as the Panasonic soundbar truncate request URIs at 1024
     * bytes, so the long signed googlevideo URL cannot be handed to them
     * directly (they would request a truncated URL and Google would answer
     * 403). The renderer gets a short token instead, which we expand here.
     *
     * Some renderers (again the Panasonic) cannot play the fragmented MP4
     * (DASH) stream that YouTube serves either. ffmpeg remuxes it to ADTS AAC
     * on the fly, which those devices do accept.
     *
     * The 200 headers go out before the stream is attached. `play` normally
     * opens the upstream before `client.load` and hands it over here, because
     * the soundbar stops if the URL stays silent for a few seconds while
     * googlevideo rejects a freshly signed URL.
     */
    serveStream(req, res) {
        const obj = this;
        const token = req.url.split('?')[0].replace(/^\/+/, '');
        const stream = this.stream;

        const requestStarted = Date.now();
        console.log(`[${obj.friendlyName}]: Proxy ${req.method} ${req.url} from ${req.socket.remoteAddress}`);

        if (!stream || token !== stream.token) {
            console.log(`[${obj.friendlyName}]: Proxy token ${token} does not match ${stream ? stream.token : '(no stream)'}`);
            res.writeHead(404);
            res.end();
            return;
        }

        let upstream = null;
        let ffmpeg = null;
        let closed = false;

        // The renderer starts its playback clock when it receives the response
        // headers. Do not wait for the signed URL here: googlevideo answers 403
        // or 503 until the URL reaches the serving edge, and the soundbar gives
        // up if the headers take longer than a few seconds.
        res.writeHead(200, { 'Content-Type': 'audio/aac' });
        res.flushHeaders();

        const shutdown = function() {
            console.log(`[${obj.friendlyName}]: Proxy response closed after ${Date.now() - requestStarted}ms` +
                        (res.writableFinished ? ' (finished)' : ''));
            if (res.writableFinished) return;
            closed = true;
            if (upstream) upstream.destroy();
            if (ffmpeg) ffmpeg.kill();
        };

        res.on('close', shutdown);
        res.on('error', function(err) {
            console.log(`[${obj.friendlyName}]: Renderer connection error: ${err.message}`);
        });

        const startStream = function(upstreamRes) {
            if (closed) {
                upstreamRes.destroy();
                return;
            }

            upstream = upstreamRes;
            ffmpeg = spawn('ffmpeg', ['-loglevel', 'error', '-i', 'pipe:0', '-c:a', 'copy', '-f', 'adts', 'pipe:1']);

            let received = 0;
            let sent = 0;

            // A stalled upstream would otherwise look like a working stream
            // until the renderer decides on its own that playback is over.
            upstream.setTimeout(MEDIA_IDLE_TIMEOUT, function() {
                upstream.destroy(new Error(`nothing received for ${MEDIA_IDLE_TIMEOUT}ms`));
            });

            upstream.on('data', function(chunk) {
                received += chunk.length;
            });

            upstream.on('end', function() {
                const expected = Number(upstream.headers['content-length'] || 0);
                console.log(`[${obj.friendlyName}]: Upstream ended after ${received} bytes` +
                            (expected && received < expected ? ` of ${expected} (truncated)` : ''));
            });

            upstream.on('error', function(err) {
                console.log(`[${obj.friendlyName}]: Media stream failed after ${received} bytes: ${err.message}`);
                ffmpeg.stdin.end();
            });

            ffmpeg.stdout.on('data', function(chunk) {
                sent += chunk.length;
            });

            upstream.pipe(ffmpeg.stdin);
            ffmpeg.stdout.pipe(res);

            // Writing to a closed pipe must not crash the process.
            ffmpeg.stdin.on('error', function() {});

            ffmpeg.stderr.on('data', function(data) {
                console.log(`[${obj.friendlyName}]: ffmpeg: ${data.toString().trim()}`);
            });

            ffmpeg.on('error', function(err) {
                console.log(`[${obj.friendlyName}]: Unable to run ffmpeg: ${err.message}`);
                upstream.destroy();
                if (!closed) res.end();
            });

            ffmpeg.on('close', function() {
                console.log(`[${obj.friendlyName}]: Media stream closed, ${received} bytes in, ${sent} bytes out`);
                if (!closed) res.end();
            });
        };

        if (stream.upstream) {
            const ready = stream.upstream;
            stream.upstream = null;
            startStream(ready);
            return;
        }

        this.openStream(MAX_MEDIA_ATTEMPTS, function(err, upstreamRes) {
            if (err) {
                console.log(`[${obj.friendlyName}]: Media request error: ${err.message}`);
                if (!closed) res.end();
                return;
            }

            startStream(upstreamRes);
        });
    }

    /**
     * The methods implementing yt-cast-receiver.Player
     */
    async play(videoId, position = 0) {
        console.log(`[${this.friendlyName}]: Play ${videoId} at position ${position}s`);
        const obj = this;
        const generation = ++this.playGeneration;

        this.getAudioUrl(videoId, PREFERRED_MEDIA_ADDRESS_FAMILY, function(audioUrl) {
            // Stop or another play can happen while yt-dlp is resolving.
            if (generation !== obj.playGeneration) return;

            if (!audioUrl) {
                console.log(`[${obj.friendlyName}]: No audio URL`);
                return;
            }

            const url = new URL(audioUrl);

            // Create a URL to give to the renderer, served by our proxy on the
            // interface that can reach the renderer.
            const rendererHost = new URL(obj.location).hostname;
            const proxyHost = localAddressFor(rendererHost);
            if (!proxyHost) {
                console.log(`[${obj.friendlyName}]: Unable to determine local address for proxy`);
                return;
            }

            if (obj.stream && obj.stream.upstream) {
                obj.stream.upstream.destroy();
            }

            const token = crypto.randomBytes(8).toString('hex');
            const stream = { token: token, url: url, videoId: videoId };
            obj.stream = stream;
            obj.ensureStreamServer();

            const proxyPort = PROXY_BASE_PORT + obj.index;
            const rendererUrl = `http://${proxyHost}:${proxyPort}/${token}`;
            console.log(`[${obj.friendlyName}]: Streaming via ${rendererUrl}`);

            const load = function() {
                // Load and play the URL on the renderer
                const options = { autoplay: true,
                                    contentType: 'audio/aac' };
                console.log(`[${obj.friendlyName}]: Loading ${rendererUrl}`);
                obj.client.load(rendererUrl, options, function(err, result) {
                    if(err) {
                        console.log(`[${obj.friendlyName}]: Error loading media:`)
                        console.log(err);
                        if (stream.upstream) {
                            stream.upstream.destroy();
                            stream.upstream = null;
                        }
                    }
                    else {
                        obj.notifyPlayed();
                    }
                });
            };

            // Open the media before telling the renderer to play. The soundbar
            // stops if the URL stays silent for a few seconds, which happens
            // while googlevideo rejects a freshly signed URL.
            console.log(`[${obj.friendlyName}]: Preparing media`);
            obj.openStream(MAX_MEDIA_ATTEMPTS, function(err, upstreamRes) {
                if (generation !== obj.playGeneration || obj.stream !== stream) {
                    if (upstreamRes) upstreamRes.destroy();
                    return;
                }

                if (err) {
                    console.log(`[${obj.friendlyName}]: Unable to prepare media: ${err.message}`);
                } else {
                    stream.upstream = upstreamRes;
                    console.log(`[${obj.friendlyName}]: Media ready`);
                }

                load();
            });
        });
    }

    async pause() {
        console.log(`[${this.friendlyName}]: Pause`);
        const obj = this;

        // Pause the dlna renderer
        this.client.pause(function(err, result) {
            if (err) {
                console.log(`[${obj.friendlyName}]: Pause error:`);
                console.log(err);
            } else {
                console.log(`[${obj.friendlyName}]: Paused`);

                // Notify YouTube that we have paused
                obj.notifyPaused();
            }
        });
    }

    async resume() {
        console.log(`[${this.friendlyName}]: Resume`);
        const obj = this;

        // Play (=resume) the dlna renderer
        this.client.play(function(err, result) {
            if (err) {
                console.log(`[${obj.friendlyName}]: Resume error:`);
                console.log(err);
            } else {
                console.log(`[${obj.friendlyName}]: Resumed`);

                // Notify YouTube that we have resumed
                obj.notifyResumed();
            }
        });
    }

    async stop() {
        console.log(`[${this.friendlyName}]: Stop`);
        const obj = this;

        if (this.stream && this.stream.upstream) {
            this.stream.upstream.destroy();
            this.stream.upstream = null;
        }
        this.stream = null;
        this.playGeneration += 1;

        // Stop the dlna renderer
        this.client.stop(function(err, result) {
            if (err) {
                console.log(`[${obj.friendlyName}]: Stop error:`);
                console.log(err);
            } else {
                console.log(`[${obj.friendlyName}]: Stopped`);

                // Notify YouTube that we have stopped
                obj.notifyStopped();
            }
        });
    }

    async seek(position, statusBeforeSeek) {
        console.log(`[${this.friendlyName}]: Seek to ${position}s, statusBeforeSeek ${statusBeforeSeek}`);
        const obj = this;

        // Tell the dlna renderer to seek
        this.client.seek(position, function(err, result) {
            if (err) {
                console.log(`[${obj.friendlyName}]: Seek error:`);
                console.log(err);
            } else {
                console.log(`[${obj.friendlyName}]: Seeked`);

                // Notify YouTube that we have seeked
                obj.notifySeeked(statusBeforeSeek);
            }
        });
    }

    async getVolume() {
        console.log(`[${this.friendlyName}]: getVolume`);
        const obj = this;

        const promise = new Promise(function(resolve, reject) {
            obj.client.getVolume(function(err, result) {
                if(err) {
                    console.log(`[${obj.friendlyName}]: getVolume error:`);
                    console.log(err);
                    reject(err);
                } else {
                    console.log(`[${obj.friendlyName}]: getVolume ${result}`);
                    resolve(result);
                }
            })
        });

        return promise;
    }

    async setVolume(volume) {
        console.log(`[${this.friendlyName}]: setVolume to ${volume}`);
        const obj = this;

        // Set the volume on the dlna renderer
        this.client.setVolume(volume, function(err, result) {
            if (err) {
                console.log(`[${obj.friendlyName}]: setVolume error:`);
                console.log(err);
            } else {
                console.log(`[${obj.friendlyName}]: Volume set`);

                // Notify YouTube that we have stopped
                obj.notifyVolumeChanged();
            }
        });
    }

    async getPosition() {
        console.log(`[${this.friendlyName}]: getPosition`);

        const obj = this;

        const promise = new Promise(function(resolve, reject) {
            obj.client.getPosition(function(err, result) {
                if(err) {
                    console.log(`[${obj.friendlyName}]: getPosition error:`);
                    console.log(err);
                    reject(err);
                } else {
                    console.log(`[${obj.friendlyName}]: getPosition ${result}`);
                    resolve(result);
                }
            })
        });

        return promise;
    }

    async getDuration() {
        console.log(`[${this.friendlyName}]: getDuration`);

        // The renderer reports duration 0 because the proxy stream has no
        // length. The signed URL carries the real duration, which the sender
        // needs for its nowPlaying state.
        if (this.stream) {
            const duration = Number(this.stream.url.searchParams.get('dur'));
            if (Number.isFinite(duration) && duration > 0) {
                console.log(`[${this.friendlyName}]: getDuration ${duration} (media URL)`);
                return duration;
            }
        }

        const obj = this;

        const promise = new Promise(function(resolve, reject) {
            obj.client.getDuration(function(err, result) {
                if(err) {
                    console.log(`[${obj.friendlyName}]: getDuration error:`);
                    console.log(err);
                    reject(err);
                } else {
                    console.log(`[${obj.friendlyName}]: getDuration ${result}`);
                    resolve(result);
                }
            })
        });

        return promise;
    }
}

// TODO Work out how to export only the things we want to export
module.exports = { Renderer };

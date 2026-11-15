const { Console } = require('console');
const MediaRendererClient = require('upnp-mediarenderer-client');
const { exec, spawn } = require('child_process');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const net = require('net');
const os = require('os');

// TODO: Ideally the author will accept the pull request and re-publish. Otherwise tie it to my fork.
const Ytcr = require('yt-cast-receiver');

// Use ports 3000, 3001, 3002 etc for successive YTCRs
const YTCR_BASE_PORT = 3000;

// Use port 800n for the HTTPS->HTTP proxying of the media
const PROXY_BASE_PORT = 8000;

// How often the media proxy follows a redirect from googlevideo before it
// gives up on one attempt (the chains are routinely two to three hops long),
// how many attempts it makes in total, how long it waits between them, how
// long it waits for an edge to answer, and how long it tolerates silence
// while the stream is running.
const MAX_MEDIA_REDIRECTS = 8;
const MAX_MEDIA_ATTEMPTS = 3;
const MEDIA_RETRY_DELAY = 500;
const MEDIA_CONNECT_TIMEOUT = 10000;
const MEDIA_IDLE_TIMEOUT = 15000;

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
 * Fetch a signed googlevideo URL and follow its redirects.
 *
 * `hops` collects "status@host" entries so a failure can name the server that
 * rejected the request. The callback gets either an error or a readable
 * upstream response.
 */
function followMediaRedirects(url, hops, redirectsLeft, callback) {
    const options = {
        headers: { range: 'bytes=0-' },
        timeout: MEDIA_CONNECT_TIMEOUT
    };
    const family = addressFamilyOf(url);
    if (family) options.family = family;

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
        hops.push(`${status}@${url.hostname}`);

        if (status >= 300 && status < 400 && location) {
            response.resume();

            if (redirectsLeft <= 0) {
                finish(new Error(`redirected too often (${hops.join(' ')})`));
                return;
            }

            followMediaRedirects(new URL(location, url), hops, redirectsLeft - 1, finish);
            return;
        }

        if (status !== 200 && status !== 206) {
            // googlevideo explains rejects in the body; keep a short excerpt.
            let body = '';
            const fail = function() {
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
            const options = {port: YTCR_BASE_PORT + obj.index,
                             friendlyName: obj.friendlyName,
                             manufacturer: description.manufacturer,
                             modelName: description.modelName}; 
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
     * The callback always fires: with the URL, or with null when both tools failed.
     */
    getAudioUrl(videoId, callback) {
        const obj = this;

        // Call yt-dlp to get the audio URL
        exec(`yt-dlp -f bestaudio[ext=m4a] --get-url https://www.youtube.com/watch?v=${videoId}`, function(err, stdout, stderr) {
            if(err) {
                console.log(`[${obj.friendlyName}]: Unable to get audio URL using yt-dlp. Using youtube-dl but this is slower!`);

                // Enable to see what went wrong
                // console.log(err);
                // if(stdout) {
                //     console.log(stdout);
                // }
                // if(stderr) {
                //     console.log(stderr);
                // }

                exec(`youtube-dl -f bestaudio[ext=m4a] --get-url https://www.youtube.com/watch?v=${videoId}`, function(err, stdout, stderr) {
                    if(err) {
                        console.log(`[${obj.friendlyName}]: Error getting URL from youtube-dl:`);
                        // Enable to see what went wrong
                        // console.log(err);
                        // if(stdout) {
                        //     console.log(stdout);
                        // }
                        // if(stderr) {
                        //     console.log(stderr);
                        // }
                        callback(null);
                    } else {
                        // Call the callback with the retrieved URL
                        const audioUrl = stdout.toString().trim();
                        console.log(`[${obj.friendlyName}]: Media URL: ${audioUrl}`);
                        callback(audioUrl);
                    }
                });
            }
            else {
                // Call the callback with the retrieved URL
                const audioUrl = stdout.toString().trim();
                console.log(`[${obj.friendlyName}]: Media URL: ${audioUrl}`);
                callback(audioUrl);
            }
        });
    }

    /**
     * Open the media stream for the current track.
     *
     * googlevideo answers with a redirect to a freshly signed URL on another
     * edge server, and an edge that does not carry the stream answers 403.
     * Asking the same URL again cannot repair that: the URL is bound to the
     * client IP address and to the edge that signed it. So each attempt that
     * fails resolves a fresh URL with yt-dlp first.
     */
    openStream(attemptsLeft, callback) {
        const obj = this;
        const stream = this.stream;

        followMediaRedirects(stream.url, [], MAX_MEDIA_REDIRECTS, function(err, response) {
            if (!err) {
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

                obj.getAudioUrl(stream.videoId, function(audioUrl) {
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
     */
    serveStream(req, res) {
        const obj = this;
        const token = req.url.split('?')[0].replace(/^\/+/, '');
        const stream = this.stream;

        if (!stream || token !== stream.token) {
            res.writeHead(404);
            res.end();
            return;
        }

        this.openStream(MAX_MEDIA_ATTEMPTS, function(err, upstreamRes) {
            if (err) {
                console.log(`[${obj.friendlyName}]: Media request error: ${err.message}`);
                res.writeHead(502);
                res.end();
                return;
            }

            const ffmpeg = spawn('ffmpeg', ['-loglevel', 'error', '-i', 'pipe:0', '-c:a', 'copy', '-f', 'adts', 'pipe:1']);

            let received = 0;
            let sent = 0;

            // A stalled upstream would otherwise look like a working stream
            // until the renderer decides on its own that playback is over.
            upstreamRes.setTimeout(MEDIA_IDLE_TIMEOUT, function() {
                upstreamRes.destroy(new Error(`nothing received for ${MEDIA_IDLE_TIMEOUT}ms`));
            });

            upstreamRes.on('data', function(chunk) {
                received += chunk.length;
            });

            upstreamRes.on('end', function() {
                const expected = Number(upstreamRes.headers['content-length'] || 0);
                console.log(`[${obj.friendlyName}]: Upstream ended after ${received} bytes` +
                            (expected && received < expected ? ` of ${expected} (truncated)` : ''));
            });

            upstreamRes.on('error', function(err) {
                console.log(`[${obj.friendlyName}]: Media stream failed after ${received} bytes: ${err.message}`);
                ffmpeg.stdin.end();
            });

            ffmpeg.stdout.on('data', function(chunk) {
                sent += chunk.length;
            });

            res.on('error', function(err) {
                console.log(`[${obj.friendlyName}]: Renderer connection error: ${err.message}`);
            });

            res.writeHead(200, { 'Content-Type': 'audio/aac' });
            upstreamRes.pipe(ffmpeg.stdin);
            ffmpeg.stdout.pipe(res);

            // Writing to a closed pipe must not crash the process.
            ffmpeg.stdin.on('error', function() {});

            ffmpeg.stderr.on('data', function(data) {
                console.log(`[${obj.friendlyName}]: ffmpeg: ${data.toString().trim()}`);
            });

            ffmpeg.on('error', function(err) {
                console.log(`[${obj.friendlyName}]: Unable to run ffmpeg: ${err.message}`);
                upstreamRes.destroy();
                res.end();
            });

            ffmpeg.on('close', function() {
                console.log(`[${obj.friendlyName}]: Media stream closed, ${received} bytes in, ${sent} bytes out`);
                res.end();
            });

            req.on('close', function() {
                upstreamRes.destroy();
                ffmpeg.kill();
            });
        });
    }

    /**
     * The methods implementing yt-cast-receiver.Player
     */
    async play(videoId, position = 0) {
        console.log(`[${this.friendlyName}]: Play ${videoId} at position ${position}s`);
        const obj = this;

        this.getAudioUrl(videoId, function(audioUrl) {
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

            const token = crypto.randomBytes(8).toString('hex');
            obj.stream = { token: token, url: url, videoId: videoId };
            obj.ensureStreamServer();

            const proxyPort = PROXY_BASE_PORT + obj.index;
            const rendererUrl = `http://${proxyHost}:${proxyPort}/${token}`;
            console.log(`[${obj.friendlyName}]: Streaming via ${rendererUrl}`);

            // Load and play the URL on the renderer
            const options = { autoplay: true,
                                contentType: 'audio/aac' };
            obj.client.load(rendererUrl, options, function(err, result) {
                if(err) {
                    console.log(`[${obj.friendlyName}]: Error loading media:`)
                    console.log(err);
                }
                else {
                    obj.notifyPlayed();
                }
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

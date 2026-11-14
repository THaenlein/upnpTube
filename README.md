# upnpTube
Cast from YouTube app to DLNA/UPNP renderers.

Run upnpTube on a machine on your local network. It finds all UPnP / DLNA renderers (Wifi speakers, amplifiers, smart TVs etc.) and lets you cast to them from the Android/iPhone YouTube apps.

The YouTube app can be used to play, pause, stop and control the volume of the player.


## Installation

### Local installation
Install npm and node.js:

    sudo apt install npm
    
Install upnpTube:

    mkdir upnpTube
    cd upnpTube
    npm install https://github.com/mas94uk/upnpTube
    sudo npm link
    
Install yt-dlp and ffmpeg:

    sudo apt install yt-dlp ffmpeg

Run it:

    upnpTube
    

### Installation using Docker
Clone this repository:

    git clone git@github.com:mas94uk/upnpTube.git

Create and start the Docker image:

    cd upnpTube
    podman compose up [--detach]

### Firewall

The YouTube app fetches the DIAL device description and sends commands to the
cast receiver, and the DLNA renderer fetches the audio stream from the proxy.
Both need inbound TCP access to the host. With `ufw` (default policy `DROP`),
discovery over SSDP still works because ufw allows multicast on UDP 1900, but
the device is then hidden from the cast list because the description request is
dropped. Allow the cast receiver (`3000+index`) and proxy (`8000+index`) ports
from the local network:

    sudo ufw allow from <LAN subnet> to any port 3000:3099 proto tcp
    sudo ufw allow from <LAN subnet> to any port 8000:8099 proto tcp

### How it works
upnpTube scans for DLNA/UPNP renderers on your network. For each one it finds, it creates a YouTube Cast Receiver, named after the renderer.
When a YouTube Cast Receiver receives a cast, it uses yt-dlp to find an audio-only stream, which it remuxes to ADTS AAC with ffmpeg (since YouTube serves fragmented MP4 and HTTPS, which many renderers do not support) and serves over HTTP to the renderer.


### Limitations

Seeking does not work. I have not done much investigation into why.

The stream is remuxed on the fly, so its length is unknown: renderers
report a duration of 0 and the YouTube app cannot show a progress bar.

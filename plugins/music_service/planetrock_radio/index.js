'use strict';

var libQ = require('kew');
var fs = require('fs-extra');
var config = require('v-conf');
var http = require('http');
var EventSource = require('eventsource');
var axios = require('axios');
var net = require('net');

module.exports = ControllerPlanetRockRadio;

function ControllerPlanetRockRadio(context) {
  var self = this;

  self.context = context;
  self.commandRouter = this.context.coreCommand;
  self.logger = this.context.logger;
  self.configManager = this.context.configManager;
  self.state = {};
  self.stateMachine = self.commandRouter.stateMachine;
  self.csrfToken = null;
  self.sessionCookie = null;
  self.userId = null; // Will be set from JWT token
  self.aisSessionId = null;
  self.eventSource = null;
  self.proxyServer = null;
  self.proxyPort = null;
  self.isFirstMetadataUpdate = true; // Add flag for first update
  self.metadataUpdateTimer = null; // Add timer reference

  self.logger.info("ControllerPlanetRockRadio::constructor");
}

ControllerPlanetRockRadio.prototype.onVolumioStart = function()
{
  var self = this;
  self.configFile = this.commandRouter.pluginManager.getConfigurationFile(this.context,'config.json');
  self.getConf(self.configFile);
  return libQ.resolve();
};

ControllerPlanetRockRadio.prototype.getConfigurationFiles = function () {
  return ['config.json'];
};

ControllerPlanetRockRadio.prototype.onStart = function() {
  var self = this;
  self.mpdPlugin = this.commandRouter.pluginManager.getPlugin('music_service','mpd');
  self.addToBrowseSources();
  self.serviceName = "planetrock_radio";
  return libQ.resolve();
};

ControllerPlanetRockRadio.prototype.onStop = function() {
  var self = this;
  if (self.eventSource) {
    self.eventSource.close();
    self.eventSource = null;
  }
  if (self.proxyServer) {
    self.proxyServer.close();
    self.proxyServer = null;
  }
  return libQ.resolve();
};

ControllerPlanetRockRadio.prototype.onRestart = function() {
  var self = this;
  return libQ.resolve();
};

ControllerPlanetRockRadio.prototype.getConf = function(configFile) {
  var self = this;
  self.config = new (require('v-conf'))();
  self.config.loadFile(configFile);
};

ControllerPlanetRockRadio.prototype.setConf = function(conf) {
  var self = this;
  fs.writeJsonSync(self.configFile, JSON.stringify(conf));
};

ControllerPlanetRockRadio.prototype.getUIConfig = function() {
  var self = this;
  var defer = libQ.defer();
  var lang_code = this.commandRouter.sharedVars.get('language_code');

  self.commandRouter.i18nJson(__dirname+'/i18n/strings_' + lang_code + '.json',
      __dirname + '/i18n/strings_en.json',
      __dirname + '/UIConfig.json')
  .then(function(uiconf)
  {
    uiconf.sections[0].content[0].value = self.config.get('username');
    uiconf.sections[0].content[1].value = self.config.get('password');
    uiconf.sections[0].content[2].value = self.config.get('metadata_delay', 10);
    defer.resolve(uiconf);
  })
  .fail(function()
  {
    defer.reject(new Error());
  });

  return defer.promise;
};

ControllerPlanetRockRadio.prototype.getRadioI18nString = function(key) {
  var self = this;
  var lang_code = this.commandRouter.sharedVars.get('language_code');
  var i18n_strings = fs.readJsonSync(__dirname+'/i18n/strings_' + lang_code + '.json');
  return i18n_strings[key];
};

ControllerPlanetRockRadio.prototype.addToBrowseSources = function () {
  var self = this;
  self.commandRouter.volumioAddToBrowseSources({
    name: self.getRadioI18nString('PLUGIN_NAME'),
    uri: 'planetrock',
    plugin_type: 'music_service',
    plugin_name: "planetrock_radio",
    albumart: '/albumart?sourceicon=music_service/planetrock_radio/assets/planetrock_radio.webp'
  });
};

ControllerPlanetRockRadio.prototype.handleBrowseUri = function (curUri) {
  var self = this;
  var defer = libQ.defer();

  if (curUri.startsWith('planetrock')) {
    if (curUri === 'planetrock') {
      self.getRootContent()
        .then(function(response) {
          defer.resolve(response);
        })
        .fail(function(error) {
          self.logger.error('ControllerPlanetRockRadio::handleBrowseUri failed: ' + error);
          defer.reject(error);
        });
    } else {
      defer.reject(new Error('Invalid URI'));
    }
  } else {
    defer.reject(new Error('Invalid URI'));
  }

  return defer.promise;
};

ControllerPlanetRockRadio.prototype.updateConfig = function(data) {
  var self = this;
  var defer = libQ.defer();
  var configUpdated = false;

  if (self.config.get('username') !== data['username']) {
    self.config.set('username', data['username']);
    configUpdated = true;
  }

  if (self.config.get('password') !== data['password']) {
    self.config.set('password', data['password']);
    configUpdated = true;
  }

  if (self.config.get('metadata_delay') !== data['metadata_delay']) {
    self.config.set('metadata_delay', data['metadata_delay']);
    configUpdated = true;
  }

  if (configUpdated) {
    // Clear any existing auth tokens when credentials change
    self.csrfToken = null;
    self.sessionCookie = null;
  }

  defer.resolve();
  return defer.promise;
};

ControllerPlanetRockRadio.prototype.extractJwtPayload = function(cookies) {
  var self = this;
  if (!cookies) return null;

  // Find the JWT cookie
  var jwtCookie = cookies.find(function(cookie) {
    return cookie.startsWith('jwt-radio-uk-sso-uk_radio=');
  });

  if (!jwtCookie) return null;

  // Extract the JWT token value
  var jwtToken = jwtCookie.split('=')[1].split(';')[0];

  try {
    // JWT tokens are base64url encoded and have three parts separated by dots
    var parts = jwtToken.split('.');
    if (parts.length !== 3) {
      throw new Error('Invalid JWT format');
    }

    // Decode the payload (second part)
    var payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
    return payload;
  } catch (error) {
    self.logger.error('Failed to parse JWT token: ' + error.message);
    return null;
  }
};

ControllerPlanetRockRadio.prototype.authenticate = function() {
  var self = this;
  var defer = libQ.defer();

  // Check if we have credentials
  var username = self.config.get('username');
  var password = self.config.get('password');

  if (!username || !password) {
    defer.reject(new Error(self.getRadioI18nString('ERROR_AUTH_REQUIRED')));
    return defer.promise;
  }

  // First get the CSRF token
  self.logger.info('Making CSRF token request to: https://account.planetradio.co.uk/ajax/process-account/');
  axios.post('https://account.planetradio.co.uk/ajax/process-account/')
    .then(response => {
      self.logger.info('CSRF Response Status: ' + response.status);
      self.logger.info('CSRF Response Headers: ' + JSON.stringify(response.headers, null, 2));
      self.logger.info('CSRF Response Body: ' + JSON.stringify(response.data, null, 2));

      // Get CSRF token from header
      var csrfHeader = response.headers['x-csrf-token'];
      if (!csrfHeader) {
        throw new Error('Could not find CSRF token in headers');
      }

      try {
        var csrfData = JSON.parse(csrfHeader);
        if (!csrfData.csrf_name || !csrfData.csrf_value) {
          throw new Error('Invalid CSRF token format');
        }

        // Now perform login
        var loginData = {
          'processmode': 'login',
          'emailfield': encodeURIComponent(username).replace(/!/g, '%21').replace(/'/g, '%27').replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/\*/g, '%2A'),
          'passwordfield': encodeURIComponent(password).replace(/!/g, '%21').replace(/'/g, '%27').replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/\*/g, '%2A'),
          'authMethod': 'native',
          'csrf_name': csrfData.csrf_name,
          'csrf_value': csrfData.csrf_value
        };

        // Convert to form-urlencoded format
        var formData = Object.keys(loginData)
          .map(key => key + '=' + loginData[key])
          .join('&');

        self.logger.info('Making login request with form data: ' + formData);
        self.logger.info('Login request headers: ' + JSON.stringify({
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-CSRF-Token': csrfHeader,
          'Cookie': response.headers['set-cookie']
        }, null, 2));

        // Return both the login request promise and the csrfData
        return {
          loginPromise: axios.post('https://account.planetradio.co.uk/ajax/process-account/', formData, {
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'X-CSRF-Token': csrfHeader,
              'Cookie': response.headers['set-cookie']
            }
          }),
          csrfData: csrfData
        };
      } catch (error) {
        self.logger.error('Failed to parse CSRF token: ' + error.message);
        throw error;
      }
    })
    .then(({ loginPromise, csrfData }) => {
      return loginPromise.then(loginResponse => {
        self.logger.info('Login Response Status: ' + loginResponse.status);
        self.logger.info('Login Response Headers: ' + JSON.stringify(loginResponse.headers, null, 2));
        self.logger.info('Login Response Body: ' + JSON.stringify(loginResponse.data, null, 2));

        if (loginResponse.data && loginResponse.data.status === 601) {
          self.csrfToken = csrfData.csrf_value;
          
          // Find the specific JWT cookie we need
          var cookies = loginResponse.headers['set-cookie'];
          var jwtCookie = null;
          
          if (Array.isArray(cookies)) {
            jwtCookie = cookies.find(function(cookie) {
              return cookie.startsWith('jwt-radio-uk-sso-uk_radio=') && !cookie.includes('deleted');
            });
          }
          
          if (!jwtCookie) {
            throw new Error('Could not find valid JWT cookie in response');
          }

          self.sessionCookie = jwtCookie;

          // Extract user ID from JWT token
          var jwtPayload = self.extractJwtPayload([jwtCookie]);
          if (jwtPayload && jwtPayload.id) {
            self.userId = jwtPayload.id;
            self.logger.info('Successfully extracted user ID: ' + self.userId);
            return;
          } else {
            throw new Error('Failed to extract user ID from JWT token');
          }
        } else {
          throw new Error('Login failed: ' + JSON.stringify(loginResponse.data));
        }
      });
    })
    .then(() => {
      defer.resolve();
    })
    .catch(error => {
      self.logger.error('Authentication failed: ' + error.message);
      defer.reject(new Error(self.getRadioI18nString('ERROR_AUTH')));
    });

  return defer.promise;
};

ControllerPlanetRockRadio.prototype.getRootContent = function() {
  var self = this;
  var defer = libQ.defer();

  var currentEpoch = Math.floor(Date.now() / 1000);
  
  var streamUrl = 'https://stream-mz.hellorayo.co.uk/planetrock_premhigh.aac?' +
    'direct=false' +
    '&listenerid=' + (self.userId || '') +
    '&aw_0_1st.bauer_listenerid=' + (self.userId || '') +
    '&aw_0_1st.playerid=BMUK_inpage_html5' +
    '&aw_0_1st.skey=' + currentEpoch +
    '&aw_0_1st.bauer_loggedin=true' +
    '&user_id=' + (self.userId || '') +
    '&aw_0_1st.bauer_user_id=' + (self.userId || '') +
    '&region=GB';

  var response = {
    navigation: {
      prev: {
        uri: '/'
      },
      lists: [
        {
          availableListViews: ['list', 'grid'],
          items: [
            {
              service: self.serviceName,
              type: 'mywebradio',
              title: self.getRadioI18nString('PLUGIN_NAME'),
              artist: self.getRadioI18nString('PLUGIN_NAME'),
              album: '',
              icon: 'fa fa-music',
              uri: streamUrl,
              streamType: 'aac',
              albumart: '/albumart?sourceicon=music_service/planetrock_radio/assets/planetrock_radio.webp'
            }
          ]
        }
      ]
    }
  };

  defer.resolve(response);
  return defer.promise;
};

ControllerPlanetRockRadio.prototype.explodeUri = function(uri) {
  var self = this;
  var defer = libQ.defer();

  var response = {
    uri: uri,
    service: self.serviceName,
    name: self.getRadioI18nString('PLUGIN_NAME'),
    type: 'track',
    trackType: 'webradio',
    streamType: 'aac',
    albumart: '/albumart?sourceicon=music_service/planetrock_radio/assets/planetrock_radio.webp'
  };

  defer.resolve(response);
  return defer.promise;
};

ControllerPlanetRockRadio.prototype.startProxyServer = function() {
  var self = this;
  var defer = libQ.defer();

  // Find an available port
  var server = net.createServer();
  server.listen(0, function() {
    self.proxyPort = server.address().port;
    server.close();
    
    // Create the proxy server
    self.proxyServer = http.createServer(function(req, res) {
      if (req.url === '/stream') {
        // Handle stream request
        const currentEpoch = Math.floor(Date.now() / 1000);
        const streamUrl = 'https://stream-mz.hellorayo.co.uk/planetrock_premhigh.aac?' +
          'direct=false' +
          '&listenerid=' + self.userId +
          '&aw_0_1st.bauer_listenerid=' + self.userId +
          '&aw_0_1st.playerid=BMUK_inpage_html5' +
          '&aw_0_1st.skey=' + currentEpoch +
          '&aw_0_1st.bauer_loggedin=true' +
          '&user_id=' + self.userId +
          '&aw_0_1st.bauer_user_id=' + self.userId +
          '&region=GB';

        self.logger.info('Proxying stream request to: ' + streamUrl);

        axios({
          method: 'get',
          url: streamUrl,
          responseType: 'stream',
          headers: {
            'Accept': '*/*',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3.1 Safari/605.1.15'
          },
          httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false })
        })
        .then(response => {
          // Get cookies from response
          const cookies = response.headers['set-cookie'];
          if (cookies) {
            for (const cookie of cookies) {
              if (cookie.startsWith('AISSessionId=')) {
                self.aisSessionId = cookie.split(';')[0];
                self.logger.info('Captured AISSessionId: ' + self.aisSessionId);
                // Start metadata connection
                self.setupEventSource();
                break;
              }
            }
          }

          // Set appropriate headers
          res.writeHead(200, {
            'Content-Type': 'audio/aac',
            'Transfer-Encoding': 'chunked'
          });

          // Pipe the stream
          response.data.pipe(res);

          // Handle stream end
          response.data.on('end', () => {
            self.logger.info('Stream ended, restarting...');
            res.end();
          });

          // Handle stream error
          response.data.on('error', error => {
            self.logger.error('Stream error: ' + error);
            res.end();
          });
        })
        .catch(error => {
          self.logger.error('Stream request error: ' + error);
          res.writeHead(500);
          res.end();
        });
      }
    });

    self.proxyServer.listen(self.proxyPort, function() {
      self.logger.info('Proxy server listening on port ' + self.proxyPort);
      defer.resolve();
    });
  });

  return defer.promise;
};

ControllerPlanetRockRadio.prototype.setupEventSource = function() {
  var self = this;
  
  if (!self.aisSessionId) {
    self.logger.error('No AISSessionId available for EventSource connection');
    return;
  }

  const url = 'https://stream-mz.hellorayo.co.uk/metadata?type=json';
  self.logger.info('Connecting to EventSource URL: ' + url);
  
  const options = {
    headers: {
      'Cookie': self.aisSessionId,
      'Accept': 'text/event-stream',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3.1 Safari/605.1.15'
    },
    rejectUnauthorized: false
  };

  // Close existing EventSource if any
  if (self.eventSource) {
    self.logger.info('Closing existing EventSource connection');
    self.eventSource.close();
  }

  // Create new EventSource connection
  self.eventSource = new EventSource(url, options);

  self.eventSource.onopen = function() {
    self.logger.info('EventSource connection established');
  };

  self.eventSource.onerror = function(error) {
    const timestamp = new Date().toISOString();
    self.logger.error(`[${timestamp}] EventSource error details:`);
    self.logger.error(`[${timestamp}] - Error object:`, JSON.stringify(error, null, 2));
    self.logger.error(`[${timestamp}] - ReadyState:`, self.eventSource.readyState);
    self.logger.error(`[${timestamp}] - URL:`, url);
    self.logger.error(`[${timestamp}] - Headers:`, JSON.stringify(options.headers, null, 2));
    
    if (self.eventSource.readyState === EventSource.CLOSED) {
      self.logger.info(`[${timestamp}] Connection closed, attempting to reconnect in 1 second...`);
      setTimeout(() => self.setupEventSource(), 1000);
    }
  };

  self.eventSource.onmessage = function(event) {
    try {
      self.logger.info('Received raw EventSource message: ' + event.data);
      
      const messageData = JSON.parse(event.data);
      self.logger.info('Parsed EventSource message: ' + JSON.stringify(messageData, null, 2));
      
      if (messageData['metadata-list'] && messageData['metadata-list'].length > 0) {
        const metadata = messageData['metadata-list'][0].metadata;
        self.logger.info('Extracted metadata string: ' + metadata);
        
        const metadataObj = self.parseMetadataString(metadata);
        self.logger.info('Parsed metadata object: ' + JSON.stringify(metadataObj, null, 2));
        
        if (metadataObj.url) {
          if (metadataObj.url.endsWith('/eventdata/-1')) {
            self.logger.info('Received -1 event data URL, fetching show information');
            self.fetchShowData()
              .then(metadata => self.updateMetadata(metadata));
            return;
          }

          // Fetch track data from the API
          axios.get(metadataObj.url)
            .then(response => {
              self.logger.info('Track data response: ' + JSON.stringify(response.data, null, 2));
              
              if (response.data) {
                const trackData = response.data;
                const metadata = self.createMetadataObject(
                  trackData.eventSongTitle,
                  trackData.eventSongArtist,
                  '',
                  trackData.eventImageUrl
                );
                self.updateMetadata(metadata);
              }
            })
            .catch(error => {
              self.logger.error('Failed to fetch track data: ' + error.message);
              const metadata = self.createMetadataObject('Unknown Track', 'Planet Rock', '', '');
              self.updateMetadata(metadata);
            });
        }
      }
    } catch (error) {
      self.logger.error('Failed to parse EventSource message: ' + error.message);
      self.logger.error('Raw message data: ' + event.data);
    }
  };
};

ControllerPlanetRockRadio.prototype.parseMetadataString = function(metadata) {
  const metadataObj = {};
  metadata.split(',').forEach(pair => {
    const [key, value] = pair.split('=');
    if (key && value) {
      metadataObj[key] = value.replace(/^"|"$/g, '');
    }
  });
  return metadataObj;
};

ControllerPlanetRockRadio.prototype.createMetadataObject = function(title, artist, album, albumart, uri) {
  return {
    title: title || 'Unknown Track',
    artist: artist || 'Planet Rock',
    album: album || '',
    albumart: albumart || '/albumart?sourceicon=music_service/planetrock_radio/assets/planetrock_radio.webp',
    uri: uri || 'http://localhost:' + this.proxyPort + '/stream'
  };
};

ControllerPlanetRockRadio.prototype.updateMetadata = function(metadata) {
  const self = this;
  
  if (self.isFirstMetadataUpdate) {
    self.logger.info('First metadata update, applying immediately');
    self.pushSongState(metadata);
    self.isFirstMetadataUpdate = false;
  } else {
    // Clear any existing timer
    if (self.metadataUpdateTimer) {
      self.logger.info('Clearing existing metadata update timer');
      clearTimeout(self.metadataUpdateTimer);
    }
    
    const delay = parseInt(self.config.get('metadata_delay')) * 1000;
    self.logger.info(`Delaying metadata update by ${delay/1000} seconds...`);
    self.metadataUpdateTimer = setTimeout(() => {
      self.logger.info('Updating metadata after delay:', JSON.stringify(metadata, null, 2));
      self.pushSongState(metadata);
      self.metadataUpdateTimer = null;
    }, delay);
  }
};

ControllerPlanetRockRadio.prototype.fetchShowData = function() {
  const self = this;
  return axios.get('https://listenapi.planetradio.co.uk/api9.2/stations_nowplaying/GB?StationCode%5B%5D=pln&premium=1')
    .then(response => {
      self.logger.info('Show data response:', JSON.stringify(response.data, null, 2));
      
      if (response.data && response.data[0] && response.data[0].stationOnAir) {
        const showData = response.data[0].stationOnAir;
        return self.createMetadataObject(
          showData.episodeTitle,
          'Planet Rock',
          showData.episodeDescription,
          showData.episodeImageUrl
        );
      }
      throw new Error('No show data available');
    })
    .catch(error => {
      self.logger.error('Failed to fetch show data:', error.message);
      return self.createMetadataObject('Non stop music', 'Planet Rock', '', '');
    });
};

ControllerPlanetRockRadio.prototype.clearAddPlayTrack = function(track) {
  var self = this;
  var defer = libQ.defer();

  self.commandRouter.logger.info("ControllerPlanetRockRadio::clearAddPlayTrack");

  // First authenticate
  self.authenticate()
    .then(function() {
      // Start proxy server if not already running
      if (!self.proxyServer) {
        return self.startProxyServer();
      }
      return libQ.resolve();
    })
    .then(function() {
      // Update track URI to use local proxy
      track.uri = 'http://localhost:' + self.proxyPort + '/stream';
      
      return self.mpdPlugin.sendMpdCommand('stop', []);
    })
    .then(function () {
      return self.mpdPlugin.sendMpdCommand('clear', []);
    })
    .then(function () {
      return self.mpdPlugin.sendMpdCommand('add "' + track.uri + '"', []);
    })
    .then(function () {
      return self.mpdPlugin.sendMpdCommand('consume 1', []);
    })
    .then(function () {
      self.commandRouter.pushToastMessage('info',
        self.getRadioI18nString('PLUGIN_NAME'),
        self.getRadioI18nString('WAIT_FOR_RADIO_CHANNEL'));

      return self.mpdPlugin.sendMpdCommand('play', []);
    })
    .then(function () {
      self.state.status = 'play';
      self.commandRouter.servicePushState(self.state, self.serviceName);
      return libQ.resolve();
    })
    .fail(function (e) {
      self.logger.error('Failed to start playback: ' + e);
      return libQ.reject(new Error(self.getRadioI18nString('ERROR_AUTH')));
    });
};

ControllerPlanetRockRadio.prototype.pushSongState = function(metadata) {
  var self = this;
  
  self.logger.info('pushSongState called. Fetching MPD status...');
  // Get MPD status to get actual audio format
  self.mpdPlugin.sendMpdCommand('status', [])
    .then(function (status) {
      self.logger.info('MPD status command returned. Response received:');
      self.logger.info('----------------- MPD STATUS START -----------------');
      self.logger.info('Type of status response: ' + typeof status);
      self.logger.info('Is status response null? ' + (status === null));
      self.logger.info('Raw status response (stringified): ' + JSON.stringify(status, null, 2));
      self.logger.info('------------------ MPD STATUS END ------------------');
      
      if (status) {
        self.logger.info('Parsing MPD status for audio info.');
        // Handle samplerate from 'audio' string (e.g., "44100:f:2")
        if (typeof status.audio === 'string') {
          const audioParts = status.audio.split(':');
          if (audioParts.length > 0 && audioParts[0]) {
            self.state.samplerate = audioParts[0] + ' Hz';
            self.logger.info('Parsed samplerate: ' + self.state.samplerate);
          } else {
            self.state.samplerate = '-';
          }
        } else {
          self.logger.warn('status.audio is not a string or is missing.');
          self.state.samplerate = '-';
        }

        // Handle bitrate
        if (status.bitrate) {
          self.state.bitrate = status.bitrate + ' kbps';
          self.logger.info('Parsed bitrate: ' + self.state.bitrate);
        } else {
          self.state.bitrate = '-';
        }
      } else {
        self.logger.warn('MPD status object is empty or null.');
        self.state.samplerate = '-';
        self.state.bitrate = '-';
      }

      var planetRockState = {
        status: 'play',
        service: self.serviceName,
        type: 'webradio',
        trackType: 'webradio',
        radioType: 'planetrock',
        albumart: metadata.albumart,
        uri: metadata.uri,
        name: metadata.title,
        title: metadata.title,
        artist: metadata.artist,
        duration: 0,
        streaming: true,
        disableUiControls: true,
        seek: false,
        pause: false,
        stop: true,
        samplerate: self.state.samplerate || '-',
        bitrate: self.state.bitrate || '-',
        channels: 2
      };

      self.state = planetRockState;

      // Workaround to allow state to be pushed when not in a volatile state
      var vState = self.commandRouter.stateMachine.getState();
      var queueItem = self.commandRouter.stateMachine.playQueue.arrayQueue[vState.position];

      queueItem.name = metadata.title;
      queueItem.artist = metadata.artist;
      queueItem.albumart = metadata.albumart;
      queueItem.trackType = 'webradio';
      queueItem.duration = 0;
      queueItem.samplerate = self.state.samplerate || '-';
      queueItem.bitrate = self.state.bitrate || '-';
      queueItem.channels = 2;
      
      // Reset volumio internal timer
      self.commandRouter.stateMachine.currentSeek = 0;
      self.commandRouter.stateMachine.playbackStart = Date.now();
      self.commandRouter.stateMachine.currentSongDuration = 0;
      self.commandRouter.stateMachine.askedForPrefetch = false;
      self.commandRouter.stateMachine.prefetchDone = false;
      self.commandRouter.stateMachine.simulateStopStartDone = false;

      // Volumio push state
      self.commandRouter.servicePushState(planetRockState, self.serviceName);
    })
    .fail(function(error) {
      self.logger.error('Failed to get MPD status:', error);
      // Still update the state with metadata even if MPD status fails
      var planetRockState = {
        status: 'play',
        service: self.serviceName,
        type: 'webradio',
        trackType: 'webradio',
        radioType: 'planetrock',
        albumart: metadata.albumart,
        uri: metadata.uri,
        name: metadata.title,
        title: metadata.title,
        artist: metadata.artist,
        duration: 0,
        streaming: true,
        disableUiControls: true,
        seek: false,
        pause: false,
        stop: true,
        samplerate: '-',
        bitrate: '-',
        channels: 2
      };

      self.state = planetRockState;
      self.commandRouter.servicePushState(planetRockState, self.serviceName);
    });
};

ControllerPlanetRockRadio.prototype.stop = function() {
  var self = this;
  var defer = libQ.defer();

  // Clear any pending metadata update timer
  if (self.metadataUpdateTimer) {
    self.logger.info('Clearing pending metadata update timer');
    clearTimeout(self.metadataUpdateTimer);
    self.metadataUpdateTimer = null;
  }

  // Close EventSource connection immediately
  if (self.eventSource) {
    self.logger.info('Closing EventSource connection');
    self.eventSource.close();
    self.eventSource = null;
  }

  // Stop MPD playback first
  return self.mpdPlugin.sendMpdCommand('stop', [])
    .then(function() {
      return self.mpdPlugin.sendMpdCommand('clear', []);
    })
    .then(function() {
      // Close proxy server after MPD is stopped
      if (self.proxyServer) {
        self.logger.info('Closing proxy server');
        self.proxyServer.close();
        self.proxyServer = null;
        self.proxyPort = null;
      }

      // Reset first update flag
      self.isFirstMetadataUpdate = true;

      self.state.status = 'stop';
      self.commandRouter.servicePushState(self.state, self.serviceName);
      return libQ.resolve();
    })
    .fail(function(error) {
      self.logger.error('Error stopping playback: ' + error);
      // Even if MPD commands fail, close proxy and update state
      if (self.proxyServer) {
        self.logger.info('Closing proxy server after MPD error');
        self.proxyServer.close();
        self.proxyServer = null;
        self.proxyPort = null;
      }
      self.isFirstMetadataUpdate = true;
      self.state.status = 'stop';
      self.commandRouter.servicePushState(self.state, self.serviceName);
      return libQ.resolve();
    });
};

ControllerPlanetRockRadio.prototype.pause = function() {
  var self = this;
  var defer = libQ.defer();

  self.commandRouter.volumioStop();

  return defer.promise;
};

ControllerPlanetRockRadio.prototype.resume = function() {
  var self = this;
  var defer = libQ.defer();

  self.commandRouter.volumioPlay();

  return defer.promise;
};

ControllerPlanetRockRadio.prototype.seek = function(position) {
  var self = this;
  var defer = libQ.defer();

  return defer.promise;
};

ControllerPlanetRockRadio.prototype.next = function() {
  var self = this;
  var defer = libQ.defer();

  self.commandRouter.volumioNext();

  return defer.promise;
};

ControllerPlanetRockRadio.prototype.previous = function() {
  var self = this;
  var defer = libQ.defer();

  return defer.promise;
}; 
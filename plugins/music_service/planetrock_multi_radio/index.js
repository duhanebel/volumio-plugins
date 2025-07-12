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
  self.currentStationCode = 'pln'; // default
  self.lastStreamUrl = null;
  self.hlsCleanupFunction = null; // For HLS stream cleanup

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
  self.serviceName = "planetrock_multi_radio";
  self.addToBrowseSources();
  return libQ.resolve();
};

ControllerPlanetRockRadio.prototype.onStop = function() {
  var self = this;
  self.logger.info('Plugin stopping - cleaning up all resources');
  
  // Reset all streaming state
  self.resetStreamingState();
  
  self.logger.info('Plugin cleanup completed');
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
  self.config.saveFile();
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
  self.logger.info('Adding Planet Rock Multi Radio to browse sources');
  self.commandRouter.volumioAddToBrowseSources({
    name: self.getRadioI18nString('PLUGIN_NAME'),
    uri: 'planetrock_multi',
    plugin_type: 'music_service',
    plugin_name: "planetrock_multi_radio",
    albumart: '/albumart?sourceicon=music_service/planetrock_multi_radio/assets/planetrock_multi_radio.webp'
  });
  self.logger.info('Planet Rock Multi Radio added to browse sources');
};

ControllerPlanetRockRadio.prototype.handleBrowseUri = function (curUri) {
  var self = this;
  var defer = libQ.defer();
  
  self.logger.info('handleBrowseUri called with URI: ' + curUri);

  if (curUri.startsWith('planetradio/')) {
    // User selected a related station, fetch its info and resolve stream URL
    const stationCode = curUri.split('/')[1];
    axios.get('https://listenapi.planetradio.co.uk/api9.2/initweb/' + stationCode)
      .then(function(response) {
        const station = response.data;
        // Find the correct stream
        let streamUrl = null;
        if (Array.isArray(station.stationStreams)) {
          const stream = station.stationStreams.find(s =>
            s.streamQuality === 'hq' &&
            s.streamPremium === 'true'
          );
          if (stream) {
            streamUrl = stream.streamUrl;
          }
        }
        if (!streamUrl) {
          throw new Error('No suitable stream found for station ' + stationCode);
        }
        
        // Detect stream type
        const streamType = self.detectStreamType(streamUrl);
        self.logger.info(`[handleBrowseUri] Detected stream type: ${streamType} for station ${stationCode}`);
        
        // Return a single playable item
        const item = {
          service: self.serviceName,
          type: 'mywebradio',
          title: station.stationName,
          artist: station.stationName,
          album: '',
          icon: 'fa fa-music',
          uri: 'planetradio/' + stationCode, // Use custom URI for on-demand resolution
          streamUrl: streamUrl, // Store basic stream URL without parameters
          streamType: streamType, // Add stream type
          albumart: station.stationHeaderLogo || '/albumart?sourceicon=music_service/planetrock_multi_radio/assets/planetrock_multi_radio.webp'
        };
        defer.resolve({
          navigation: {
            prev: { uri: 'planetradio' },
            lists: [
              {
                availableListViews: ['list', 'grid'],
                title: station.stationName,
                items: [item]
              }
            ]
          }
        });
      })
      .catch(function(error) {
        self.logger.error('Failed to resolve station stream: ' + error);
        defer.reject(error);
      });
    return defer.promise;
  }

  if (curUri.startsWith('planetrock_multi')) {
    if (curUri === 'planetrock_multi') {
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
    
    // Save the configuration to file
    self.config.saveFile();
    self.logger.info('Configuration updated and saved');
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

  // Fetch main station info
  axios.get('https://listenapi.planetradio.co.uk/api9.2/initweb/pln')
    .then(function(response) {
      if (!response.data) {
        throw new Error('No station data in API response');
      }
      const mainStation = response.data; // main station is the root object
      const brandId = mainStation.stationBrandId;
      const stations = [mainStation];
      // Add related stations with the same brandId
      if (Array.isArray(response.data.stationBrandRelated)) {
        response.data.stationBrandRelated.forEach(station => {
          if (station.stationBrandId === brandId) {
            stations.push(station);
          }
        });
      }

      // Build items for Volumio UI
      const items = stations.map((station) => {
        // For all stations, use custom URI for on-demand resolution
        const uri = 'planetradio/' + station.stationCode;
        return {
          service: self.serviceName,
          type: 'mywebradio',
          title: station.stationName,
          artist: station.stationName,
          album: '',
          icon: 'fa fa-music',
          uri: uri,
          streamType: 'aac',
          albumart: station.stationHeaderLogo || '/albumart?sourceicon=music_service/planetrock_multi_radio/assets/planetrock_multi_radio.webp'
        };
      });

      const responseObj = {
        navigation: {
          prev: { uri: '/' },
          lists: [
            {
              availableListViews: ['list', 'grid'],
              title: 'Planet Radio',
              items: items
            }
          ]
        }
      };
      defer.resolve(responseObj);
    })
    .catch(function(error) {
      self.logger.error('Failed to fetch root content: ' + error);
      defer.reject(error);
    });

  return defer.promise;
};

ControllerPlanetRockRadio.prototype.explodeUri = function(uri) {
  var self = this;
  var defer = libQ.defer();

  if (uri.startsWith('planetradio/')) {
    const stationCode = uri.split('/')[1];
    self.logger.info(`[explodeUri] Resolving stream for stationCode: ${stationCode}`);
    axios.get('https://listenapi.planetradio.co.uk/api9.2/initweb/' + stationCode)
      .then(function(response) {
        const station = response.data;
        let streamUrl = null;
        if (Array.isArray(station.stationStreams)) {
          self.logger.info(`[explodeUri] stationStreams for ${stationCode}: ` + JSON.stringify(station.stationStreams, null, 2));
          const stream = station.stationStreams.find(s =>
            s.streamQuality === 'hq' &&
            s.streamPremium === true
          );
          self.logger.info(`[explodeUri] Stream search result for ${stationCode}: ` + JSON.stringify(stream, null, 2));
          if (stream) {
            streamUrl = stream.streamUrl;
          }
        }
        if (!streamUrl) {
          self.logger.error(`[explodeUri] No suitable stream found for station ${stationCode}`);
          throw new Error('No suitable stream found for station ' + stationCode);
        }
        
        // Detect stream type
        const streamType = self.detectStreamType(streamUrl);
        self.logger.info(`[explodeUri] Detected stream type: ${streamType} for station ${stationCode}`);

        defer.resolve([{
          service: self.serviceName,
          type: 'track',
          title: station.stationName,
          artist: station.stationName,
          albumart: station.stationHeaderLogo,
          uri: 'planetradio/' + stationCode, // Use custom URI for on-demand resolution
          streamUrl: streamUrl, // Store basic stream URL without parameters
          streamType: streamType, // Add stream type
          trackType: 'webradio'
        }]);
      })
      .catch(function(error) {
        self.logger.error('[explodeUri] Failed to resolve station stream in explodeUri: ' + error);
        defer.reject(error);
      });
    return defer.promise;
  }

  // fallback for other URIs
  defer.resolve([]);
  return defer.promise;
};

ControllerPlanetRockRadio.prototype.startProxyServer = function(streamUrl, streamType) {
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
        self.logger.info('Proxying stream request to: ' + streamUrl + ' (type: ' + streamType + ')');

        if (streamType === 'hls_m3u8') {
          // Handle HLS/M3U8 streams
          self.handleHlsStream(streamUrl, res);
        } else {
          // Handle direct AAC streams (existing logic)
          self.handleDirectStream(streamUrl, res);
        }
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
            self.fetchShowData(self.currentStationCode)
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
    albumart: albumart || '/albumart?sourceicon=music_service/planetrock_multi_radio/assets/planetrock_multi_radio.webp',
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

ControllerPlanetRockRadio.prototype.fetchShowData = function(stationCode) {
  const self = this;
  const url = `https://listenapi.planetradio.co.uk/api9.2/stations_nowplaying/GB?StationCode%5B%5D=${stationCode}&premium=1`;
  return axios.get(url)
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

  // Extract station code from track.uri if possible (e.g., planetradio/[stationCode])
  let stationCode = 'pln'; // default
  if (track && track.uri && track.uri.startsWith('planetradio/')) {
    stationCode = track.uri.split('/')[1];
  }
  self.currentStationCode = stationCode;

  // Always extract the original stream URL (not the proxy URL)
  let streamUrl = track.streamUrl || track.uri;
  
  // Store the base stream URL for later use
  self.lastStreamUrl = streamUrl;

  // Get stream type from track or detect it
  const streamType = track.streamType || self.detectStreamType(streamUrl);
  self.logger.info('Starting playback with stream type: ' + streamType);

  // Always close any existing proxy server and start a new one
  if (self.proxyServer) {
    self.logger.info('Closing existing proxy server before starting a new one');
    self.proxyServer.close();
    self.proxyServer = null;
    self.proxyPort = null;
  }

  // First authenticate, then add parameters and start proxy
  self.authenticate()
    .then(function() {
      // Add authentication parameters after authentication is complete
      let authenticatedStreamUrl = streamUrl;
      if (authenticatedStreamUrl && !authenticatedStreamUrl.includes('listenerid=')) {
        const currentEpoch = Math.floor(Date.now() / 1000);
        const authParams = [
          'direct=false',
          'listenerid=' + (self.userId || ''),
          'aw_0_1st.bauer_listenerid=' + (self.userId || ''),
          'aw_0_1st.playerid=BMUK_inpage_html5',
          'aw_0_1st.skey=' + currentEpoch,
          'aw_0_1st.bauer_loggedin=true',
          'user_id=' + (self.userId || ''),
          'aw_0_1st.bauer_user_id=' + (self.userId || ''),
          'region=GB'
        ].join('&');
        
        // Check if URL already has parameters
        const separator = authenticatedStreamUrl.includes('?') ? '&' : '?';
        authenticatedStreamUrl = authenticatedStreamUrl + separator + authParams;
        
        self.logger.info('Added authentication parameters to stream URL');
        self.logger.info('Authenticated stream URL: ' + authenticatedStreamUrl);
      }
      
      return self.startProxyServer(authenticatedStreamUrl, streamType);
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

  self.logger.info('Stopping Planet Rock Multi Radio playback');

  // Stop MPD playback first
  return self.mpdPlugin.sendMpdCommand('stop', [])
    .then(function() {
      return self.mpdPlugin.sendMpdCommand('clear', []);
    })
    .then(function() {
      // Reset all streaming state
      self.resetStreamingState();
      self.logger.info('Planet Rock Multi Radio playback stopped successfully');
      return libQ.resolve();
    })
    .fail(function(error) {
      self.logger.error('Error stopping playback: ' + error);
      // Even if MPD commands fail, reset streaming state
      self.resetStreamingState();
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

ControllerPlanetRockRadio.prototype.detectStreamType = function(streamUrl) {
  var self = this;
  // Check if the stream URL is an M3U8 playlist
  if (streamUrl && streamUrl.includes('.m3u8')) {
    return 'hls_m3u8';
  }
  // Default to direct AAC stream
  return 'direct_aac';
};

ControllerPlanetRockRadio.prototype.parseM3u8Playlist = function(playlistContent) {
  var self = this;
  const lines = playlistContent.split('\n');
  const segments = [];
  let currentSegment = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    if (line.startsWith('#EXTINF:')) {
      // Parse EXTINF line
      const extinfMatch = line.match(/#EXTINF:([\d.]+),title="([^"]+)",url="([^"]+)"/);
      if (extinfMatch) {
        currentSegment = {
          duration: parseFloat(extinfMatch[1]),
          title: extinfMatch[2],
          metadataUrl: extinfMatch[3],
          segmentUrl: null
        };
      }
    } else if (line && !line.startsWith('#') && currentSegment) {
      // This is the segment URL
      currentSegment.segmentUrl = line;
      segments.push(currentSegment);
      currentSegment = null;
    }
  }

  self.logger.info('Parsed M3U8 playlist with ' + segments.length + ' segments');
  return segments;
};

ControllerPlanetRockRadio.prototype.parseMasterPlaylist = function(playlistContent) {
  var self = this;
  const lines = playlistContent.split('\n');
  const variants = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      // This is a stream variant, the next line will be the URL
      if (i + 1 < lines.length) {
        const variantUrl = lines[i + 1].trim();
        if (variantUrl && !variantUrl.startsWith('#')) {
          variants.push(variantUrl);
          i++; // Skip the next line since we've processed it
        }
      }
    }
  }

  self.logger.info('Parsed master M3U8 playlist with ' + variants.length + ' variants');
  return variants;
};

ControllerPlanetRockRadio.prototype.fetchM3u8Playlist = function(playlistUrl) {
  var self = this;
  return axios.get(playlistUrl, {
    headers: {
      'Accept': 'application/vnd.apple.mpegurl, application/x-mpegURL, text/plain, */*',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3.1 Safari/605.1.15'
    }
  })
  .then(response => {
    self.logger.info('Fetched M3U8 playlist from: ' + playlistUrl);
    
    // Check if this is a master playlist (contains stream variants)
    if (response.data.includes('#EXT-X-STREAM-INF:')) {
      self.logger.info('Detected master playlist, fetching media playlist');
      const variants = self.parseMasterPlaylist(response.data);
      
      if (variants.length > 0) {
        // Use the first variant (usually the highest quality)
        const mediaPlaylistUrl = variants[0];
        self.logger.info('Fetching media playlist from: ' + mediaPlaylistUrl);
        
        // Fetch the media playlist
        return axios.get(mediaPlaylistUrl, {
          headers: {
            'Accept': 'application/vnd.apple.mpegurl, application/x-mpegURL, text/plain, */*',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3.1 Safari/605.1.15'
          }
        })
        .then(mediaResponse => {
          self.logger.info('Fetched media playlist from: ' + mediaPlaylistUrl);
          return self.parseM3u8Playlist(mediaResponse.data);
        });
      } else {
        throw new Error('No stream variants found in master playlist');
      }
    } else {
      // This is already a media playlist
      self.logger.info('Detected media playlist, parsing directly');
      return self.parseM3u8Playlist(response.data);
    }
  })
  .catch(error => {
    self.logger.error('Failed to fetch M3U8 playlist: ' + error.message);
    throw error;
  });
};

ControllerPlanetRockRadio.prototype.fetchMetadataFromUrl = function(metadataUrl) {
  var self = this;
  return axios.get(metadataUrl)
    .then(response => {
      self.logger.info('Fetched metadata from: ' + metadataUrl);
      return response.data;
    })
    .catch(error => {
      self.logger.error('Failed to fetch metadata: ' + error.message);
      return null;
    });
};

ControllerPlanetRockRadio.prototype.streamHlsSegments = function(segments, res) {
  var self = this;
  let currentSegmentIndex = 0;
  let isStreaming = true;
  let playlistRefreshTimer = null;
  let currentPlaylistUrl = null;
  let processedSegmentUrls = new Set(); // Track which segments we've already processed
  let lastMetadataUrl = null; // Track the last metadata URL to avoid duplicate fetches

  const streamNextSegment = () => {
    if (!isStreaming) {
      self.logger.info('HLS streaming stopped');
      res.end();
      return;
    }

    // If we've reached the end of segments, refresh the playlist
    if (currentSegmentIndex >= segments.length) {
      self.logger.info('Reached end of segments, refreshing playlist...');
      self.refreshHlsPlaylist(currentPlaylistUrl, segments, res, (newSegmentsAdded) => {
        if (newSegmentsAdded > 0) {
          self.logger.info('Added ' + newSegmentsAdded + ' new segments to playlist');
        }
        streamNextSegment();
      });
      return;
    }

    const segment = segments[currentSegmentIndex];
    self.logger.info('Streaming HLS segment ' + (currentSegmentIndex + 1) + '/' + segments.length + ': ' + segment.segmentUrl);

    // Mark this segment as processed
    if (segment.segmentUrl) {
      processedSegmentUrls.add(segment.segmentUrl);
    }

    // Fetch metadata for this segment only if it's different from the last one
    if (segment.metadataUrl && 
        segment.metadataUrl !== 'https://listenapi.planetradio.co.uk/api9.2/eventdata/-1' &&
        segment.metadataUrl !== lastMetadataUrl) {
      
      self.logger.info('Fetching new metadata from: ' + segment.metadataUrl);
      lastMetadataUrl = segment.metadataUrl;
      
      self.fetchMetadataFromUrl(segment.metadataUrl)
        .then(metadataData => {
          if (metadataData) {
            const metadata = self.createMetadataObject(
              metadataData.eventSongTitle,
              metadataData.eventSongArtist,
              '',
              metadataData.eventImageUrl
            );
            self.updateMetadata(metadata);
          }
        })
        .catch(error => {
          self.logger.error('Failed to fetch segment metadata: ' + error.message);
        });
    } else if (segment.metadataUrl === lastMetadataUrl) {
      self.logger.info('Skipping metadata fetch - same URL as previous segment');
    }

    // Stream the audio segment
    axios({
      method: 'get',
      url: segment.segmentUrl,
      responseType: 'stream',
      headers: {
        'Accept': '*/*',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3.1 Safari/605.1.15'
      }
    })
    .then(response => {
      // Pipe the segment to the response
      response.data.pipe(res, { end: false });

      // Handle segment end - this is more reliable than setTimeout
      response.data.on('end', () => {
        self.logger.info('HLS segment ' + (currentSegmentIndex + 1) + ' completed');
        // Move to next segment with minimal delay to reduce gaps
        setTimeout(() => {
          currentSegmentIndex++;
          streamNextSegment();
        }, 50); // 50ms delay to ensure smooth transition
      });

      // Handle segment error
      response.data.on('error', error => {
        self.logger.error('HLS segment error: ' + error.message);
        // Continue with next segment
        currentSegmentIndex++;
        streamNextSegment();
      });
    })
    .catch(error => {
      self.logger.error('Failed to stream HLS segment: ' + error.message);
      // Continue with next segment
      currentSegmentIndex++;
      streamNextSegment();
    });
  };

  // Store the playlist URL for refresh
  currentPlaylistUrl = self.lastStreamUrl;

  // Start streaming segments
  streamNextSegment();

  // Return cleanup function
  return () => {
    isStreaming = false;
    if (playlistRefreshTimer) {
      clearTimeout(playlistRefreshTimer);
    }
  };
};

ControllerPlanetRockRadio.prototype.refreshHlsPlaylist = function(playlistUrl, currentSegments, res, continueCallback) {
  var self = this;
  
  // Add authentication parameters to the playlist URL if they're not already present
  let authenticatedPlaylistUrl = playlistUrl;
  if (authenticatedPlaylistUrl && !authenticatedPlaylistUrl.includes('listenerid=')) {
    const currentEpoch = Math.floor(Date.now() / 1000);
    const authParams = [
      'direct=false',
      'listenerid=' + (self.userId || ''),
      'aw_0_1st.bauer_listenerid=' + (self.userId || ''),
      'aw_0_1st.playerid=BMUK_inpage_html5',
      'aw_0_1st.skey=' + currentEpoch,
      'aw_0_1st.bauer_loggedin=true',
      'user_id=' + (self.userId || ''),
      'aw_0_1st.bauer_user_id=' + (self.userId || ''),
      'region=GB'
    ].join('&');
    
    // Check if URL already has parameters
    const separator = authenticatedPlaylistUrl.includes('?') ? '&' : '?';
    authenticatedPlaylistUrl = authenticatedPlaylistUrl + separator + authParams;
    
    self.logger.info('Added authentication parameters to playlist refresh URL');
    self.logger.info('Authenticated playlist URL: ' + authenticatedPlaylistUrl);
  }
  
  self.logger.info('Refreshing HLS playlist: ' + authenticatedPlaylistUrl);
  
  self.fetchM3u8Playlist(authenticatedPlaylistUrl)
    .then(newSegments => {
      if (newSegments.length === 0) {
        throw new Error('No segments found in refreshed M3U8 playlist');
      }
      
      self.logger.info('Refreshed playlist has ' + newSegments.length + ' segments');
      
      // Find which segments are new (not already in currentSegments)
      const currentSegmentUrls = new Set(currentSegments.map(seg => seg.segmentUrl));
      const newSegmentUrls = new Set(newSegments.map(seg => seg.segmentUrl));
      
      // Find segments that are in the new playlist but not in the current one
      const segmentsToAdd = newSegments.filter(segment => !currentSegmentUrls.has(segment.segmentUrl));
      
      self.logger.info('Found ' + segmentsToAdd.length + ' new segments to add');
      
      // Add only the new segments to the current playlist
      segmentsToAdd.forEach(segment => currentSegments.push(segment));
      
      // Call the callback with the number of new segments added
      continueCallback(segmentsToAdd.length);
    })
    .catch(error => {
      self.logger.error('Failed to refresh HLS playlist: ' + error.message);
      // Retry after a short delay
      setTimeout(() => {
        self.refreshHlsPlaylist(playlistUrl, currentSegments, res, continueCallback);
      }, 1000);
    });
};

ControllerPlanetRockRadio.prototype.handleDirectStream = function(streamUrl, res) {
  var self = this;
  
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
      self.logger.info('Direct stream ended, restarting...');
      res.end();
    });

    // Handle stream error
    response.data.on('error', error => {
      self.logger.error('Direct stream error: ' + error);
      res.end();
    });
  })
  .catch(error => {
    self.logger.error('Direct stream request error: ' + error);
    res.writeHead(500);
    res.end();
  });
};

ControllerPlanetRockRadio.prototype.handleHlsStream = function(playlistUrl, res) {
  var self = this;
  
  self.logger.info('Starting HLS stream handling for: ' + playlistUrl);
  
  // Set appropriate headers for HLS stream with buffering
  res.writeHead(200, {
    'Content-Type': 'audio/aac',
    'Transfer-Encoding': 'chunked',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  // Fetch and parse the M3U8 playlist
  self.fetchM3u8Playlist(playlistUrl)
    .then(segments => {
      if (segments.length === 0) {
        throw new Error('No segments found in M3U8 playlist');
      }
      
      self.logger.info('Starting HLS segment streaming with ' + segments.length + ' segments');
      
      // Create a mutable segments array for refresh functionality
      const segmentsArray = [...segments];
      
      // Start streaming segments
      self.hlsCleanupFunction = self.streamHlsSegments(segmentsArray, res);
    })
    .catch(error => {
      self.logger.error('Failed to handle HLS stream: ' + error.message);
      res.writeHead(500);
      res.end();
    });
}; 

ControllerPlanetRockRadio.prototype.resetStreamingState = function() {
  var self = this;
  self.logger.info('Resetting streaming state');
  
  // Clear any pending metadata update timer
  if (self.metadataUpdateTimer) {
    self.logger.info('Clearing pending metadata update timer');
    clearTimeout(self.metadataUpdateTimer);
    self.metadataUpdateTimer = null;
  }

  // Close EventSource connection
  if (self.eventSource) {
    self.logger.info('Closing EventSource connection');
    self.eventSource.close();
    self.eventSource = null;
  }

  // Clean up HLS stream if active
  if (self.hlsCleanupFunction) {
    self.logger.info('Cleaning up HLS stream');
    self.hlsCleanupFunction();
    self.hlsCleanupFunction = null;
  }

  // Clear any HLS-related timers
  if (self.hlsRefreshTimer) {
    self.logger.info('Clearing HLS refresh timer');
    clearTimeout(self.hlsRefreshTimer);
    self.hlsRefreshTimer = null;
  }

  // Close proxy server
  if (self.proxyServer) {
    self.logger.info('Closing proxy server');
    self.proxyServer.close();
    self.proxyServer = null;
    self.proxyPort = null;
  }

  // Reset all streaming state
  self.isFirstMetadataUpdate = true;
  self.currentStationCode = null;
  self.lastStreamUrl = null;
  self.aisSessionId = null;
  self.isHlsStreaming = false;
  self.currentHlsSegments = null;
  self.currentHlsSegmentIndex = null;
  self.lastHlsMetadataUrl = null;
  self.csrfToken = null;
  self.sessionCookie = null;
  self.userId = null;

  // Reset UI state using volatile state workaround
  self.state.status = 'stop';
  self.state.albumart = '';
  self.state.artist = 'Planet Rock';
  self.state.title = '';
  
  // Workaround to allow state to be pushed when not in a volatile state
  var vState = self.commandRouter.stateMachine.getState();
  var queueItem = self.commandRouter.stateMachine.playQueue.arrayQueue[vState.position];

  queueItem.name = '';
  queueItem.artist = 'Planet Rock';
  queueItem.albumart = '';
  queueItem.trackType = 'webradio';
  queueItem.duration = 0;
  queueItem.samplerate = '-';
  queueItem.bitrate = '-';
  queueItem.channels = 2;
  
  // Reset volumio internal timer
  self.commandRouter.stateMachine.currentSeek = 0;
  self.commandRouter.stateMachine.playbackStart = Date.now();
  self.commandRouter.stateMachine.currentSongDuration = 0;
  self.commandRouter.stateMachine.askedForPrefetch = false;
  self.commandRouter.stateMachine.prefetchDone = false;
  self.commandRouter.stateMachine.simulateStopStartDone = false;

  // Volumio push state
  self.commandRouter.servicePushState(self.state, self.serviceName);
  
  self.logger.info('Streaming state reset completed');
}; 
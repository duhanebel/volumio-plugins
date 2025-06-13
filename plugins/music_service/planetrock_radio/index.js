'use strict';

var libQ = require('kew');
var fs = require('fs-extra');
var config = require('v-conf');
var unirest = require('unirest');

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
    albumart: '/albumart?sourceicon=music_service/planetrock_radio/planetrock_radio.svg'
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
  unirest.post('https://account.planetradio.co.uk/ajax/process-account/')
    .end(function(response) {
      self.logger.info('CSRF Response Status: ' + response.status);
      self.logger.info('CSRF Response Headers: ' + JSON.stringify(response.headers, null, 2));
      self.logger.info('CSRF Response Body: ' + JSON.stringify(response.body, null, 2));

      if (response.error) {
        self.logger.error('Failed to get CSRF token: ' + response.error);
        defer.reject(new Error(self.getRadioI18nString('ERROR_AUTH')));
        return;
      }

      // Get CSRF token from header
      var csrfHeader = response.headers['x-csrf-token'];
      if (!csrfHeader) {
        self.logger.error('Could not find CSRF token in headers');
        defer.reject(new Error(self.getRadioI18nString('ERROR_AUTH')));
        return;
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

        unirest.post('https://account.planetradio.co.uk/ajax/process-account/')
          .headers({
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-CSRF-Token': csrfHeader,
            'Cookie': response.headers['set-cookie']
          })
          .send(formData)
          .end(function(loginResponse) {
            self.logger.info('Login Response Status: ' + loginResponse.status);
            self.logger.info('Login Response Error: ' + loginResponse.error);
            self.logger.info('Login Response Headers: ' + JSON.stringify(loginResponse.headers, null, 2));
            self.logger.info('Login Response Body: ' + JSON.stringify(loginResponse.body, null, 2));

            if (loginResponse.error) {
              self.logger.error('Login failed: ' + loginResponse.error);
              defer.reject(new Error(self.getRadioI18nString('ERROR_AUTH')));
              return;
            }

            if (loginResponse.body && loginResponse.body.status === 601) {
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
                self.logger.error('Could not find valid JWT cookie in response');
                defer.reject(new Error(self.getRadioI18nString('ERROR_AUTH')));
                return;
              }

              self.sessionCookie = jwtCookie;

              // Extract user ID from JWT token
              var jwtPayload = self.extractJwtPayload([jwtCookie]);
              if (jwtPayload && jwtPayload.id) {
                self.userId = jwtPayload.id;
                self.logger.info('Successfully extracted user ID: ' + self.userId);
                defer.resolve();
              } else {
                self.logger.error('Failed to extract user ID from JWT token');
                defer.reject(new Error(self.getRadioI18nString('ERROR_AUTH')));
              }
            } else {
              self.logger.error('Login failed: ' + JSON.stringify(loginResponse.body));
              defer.reject(new Error(self.getRadioI18nString('ERROR_AUTH')));
            }
          });
      } catch (error) {
        self.logger.error('Failed to parse CSRF token: ' + error.message);
        defer.reject(new Error(self.getRadioI18nString('ERROR_AUTH')));
      }
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
              streamType: 'aac'
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
    albumart: '/albumart?sourceicon=music_service/planetrock_radio/planetrock_radio.svg'
  };

  defer.resolve(response);
  return defer.promise;
};

ControllerPlanetRockRadio.prototype.clearAddPlayTrack = function(track) {
  var self = this;
  var defer = libQ.defer();

  self.commandRouter.logger.info("ControllerPlanetRockRadio::clearAddPlayTrack");

  // First authenticate
  self.authenticate()
    .then(function() {
      // Update the track URI with the authenticated user ID
      var currentEpoch = Math.floor(Date.now() / 1000);
      var authenticatedUri = track.uri.replace(/listenerid=[^&]*/, 'listenerid=' + self.userId)
                                    .replace(/aw_0_1st\.bauer_listenerid=[^&]*/, 'aw_0_1st.bauer_listenerid=' + self.userId)
                                    .replace(/user_id=[^&]*/, 'user_id=' + self.userId)
                                    .replace(/aw_0_1st\.bauer_user_id=[^&]*/, 'aw_0_1st.bauer_user_id=' + self.userId)
                                    .replace(/aw_0_1st\.skey=[^&]*/, 'aw_0_1st.skey=' + currentEpoch);

      return self.mpdPlugin.sendMpdCommand('stop', []);
    })
    .then(function () {
      return self.mpdPlugin.sendMpdCommand('clear', []);
    })
    .then(function () {
      return self.mpdPlugin.sendMpdCommand('add "' + authenticatedUri + '"', []);
    })
    .then(function () {
      return self.mpdPlugin.sendMpdCommand('consume 1', []);
    })
    .then(function () {
      self.commandRouter.pushToastMessage('info',
        self.getRadioI18nString('PLUGIN_NAME'),
        self.getRadioI18nString('WAIT_FOR_RADIO_CHANNEL'));

      return self.mpdPlugin.sendMpdCommand('play', []);
    }).then(function () {
      self.state.status = 'play';
      self.commandRouter.servicePushState(self.state, self.serviceName);
      
      // Start fetching now playing data
      self.fetchNowPlaying();
      
      return libQ.resolve();
    })
    .fail(function (e) {
      self.logger.error('Failed to start playback: ' + e);
      return libQ.reject(new Error(self.getRadioI18nString('ERROR_AUTH')));
    });
};

ControllerPlanetRockRadio.prototype.pushSongState = function(metadata) {
  var self = this;
  var planetRockState = {
    status: 'play',
    service: self.serviceName,
    type: 'webradio',
    trackType: 'aac',
    radioType: 'planetrock',
    albumart: metadata.albumart,
    uri: metadata.uri,
    name: metadata.title,
    title: metadata.title,
    artist: metadata.artist,
    album: metadata.album,
    streaming: true,
    disableUiControls: true,
    duration: metadata.duration,
    seek: 0,
    samplerate: '44.1 KHz',
    bitdepth: '16 bit',
    channels: 2
  };

  self.state = planetRockState;

  // Workaround to allow state to be pushed when not in a volatile state
  var vState = self.commandRouter.stateMachine.getState();
  var queueItem = self.commandRouter.stateMachine.playQueue.arrayQueue[vState.position];

  queueItem.name = metadata.title;
  queueItem.artist = metadata.artist;
  queueItem.album = metadata.album;
  queueItem.albumart = metadata.albumart;
  queueItem.trackType = 'Planet Rock';
  queueItem.duration = metadata.duration;
  queueItem.samplerate = '44.1 KHz';
  queueItem.bitdepth = '16 bit';
  queueItem.channels = 2;
  
  // Reset volumio internal timer
  self.commandRouter.stateMachine.currentSeek = 0;
  self.commandRouter.stateMachine.playbackStart = Date.now();
  self.commandRouter.stateMachine.currentSongDuration = metadata.duration;
  self.commandRouter.stateMachine.askedForPrefetch = false;
  self.commandRouter.stateMachine.prefetchDone = false;
  self.commandRouter.stateMachine.simulateStopStartDone = false;

  // Volumio push state
  self.commandRouter.servicePushState(planetRockState, self.serviceName);
};

ControllerPlanetRockRadio.prototype.fetchNowPlaying = function() {
  var self = this;
  
  if (self.nowPlayingTimer) {
    clearTimeout(self.nowPlayingTimer);
    self.nowPlayingTimer = null;
  }

  self.logger.info('Fetching now playing data from Planet Rock API...');
  unirest.get('https://listenapi.planetradio.co.uk/api9.2/stations_nowplaying/GB?StationCode%5B%5D=pln&premium=1')
    .end(function(response) {
      if (response.error) {
        self.logger.error('Failed to fetch now playing data: ' + response.error);
        self.logger.error('Response status: ' + response.status);
        self.logger.error('Response headers: ' + JSON.stringify(response.headers, null, 2));
        // Retry in 10 seconds on error
        self.nowPlayingTimer = setTimeout(function() {
          self.fetchNowPlaying();
        }, 10000);
        return;
      }

      try {
        self.logger.info('Response type: ' + typeof response.body);
        self.logger.info('Response body length: ' + (response.body ? response.body.length : 0));
        self.logger.info('Raw API response: ' + response.body);
        
        // Check if response.body is already an object
        var data;
        if (typeof response.body === 'object') {
          self.logger.info('Response body is already an object, no need to parse');
          data = response.body;
        } else {
          self.logger.info('Attempting to parse response body as JSON');
          data = JSON.parse(response.body);
        }
        
        if (!data) {
          throw new Error('Empty response from API');
        }
        
        if (!data[0]) {
          throw new Error('No station data in response');
        }

        var nowPlaying = data[0].stationNowPlaying;
        var onAir = data[0].stationOnAir;
        
        self.logger.info('Now Playing data: ' + JSON.stringify(nowPlaying, null, 2));
        self.logger.info('On Air data: ' + JSON.stringify(onAir, null, 2));
        
        // Default to episode information
        var metadata = {
          title: onAir.episodeTitle,
          artist: 'Planet Rock',
          album: 'Planet Rock',
          albumart: onAir.episodeImageUrl,
          duration: onAir.episodeDuration,
          uri: self.state.uri // Keep the current stream URI
        };

        // Check if we have valid now playing track data
        var hasValidTrackData = nowPlaying && 
                              nowPlaying.nowPlayingTrack && 
                              nowPlaying.nowPlayingArtist &&
                              nowPlaying.nowPlayingTrack !== self.state.title &&
                              nowPlaying.nowPlayingArtist !== self.state.artist;

        self.logger.info('Has valid track data: ' + hasValidTrackData);
        if (nowPlaying) {
          self.logger.info('Current track: ' + nowPlaying.nowPlayingTrack);
          self.logger.info('Current artist: ' + nowPlaying.nowPlayingArtist);
          self.logger.info('Current state title: ' + self.state.title);
          self.logger.info('Current state artist: ' + self.state.artist);
        }

        // If we have valid track data, use that instead
        if (hasValidTrackData) {
          metadata.title = nowPlaying.nowPlayingTrack;
          metadata.artist = nowPlaying.nowPlayingArtist;
          metadata.albumart = nowPlaying.nowPlayingImage;
          metadata.duration = nowPlaying.nowPlayingDuration;
          self.logger.info('Using track data for metadata');
        } else {
          self.logger.info('Using episode data for metadata');
        }

        // Update state using the Radio Paradise approach
        self.pushSongState(metadata);
        
        // Calculate next update time
        var endTime, duration;
        if (hasValidTrackData) {
          endTime = new Date(nowPlaying.nowPlayingTime);
          duration = nowPlaying.nowPlayingDuration;
          self.logger.info('Using track timing - End time: ' + endTime + ', Duration: ' + duration);
        } else {
          endTime = new Date(onAir.episodeStart);
          duration = onAir.episodeDuration;
          self.logger.info('Using episode timing - End time: ' + endTime + ', Duration: ' + duration);
        }

        var nextUpdate = new Date(endTime.getTime() + (duration * 1000));
        var now = new Date();
        var delay = Math.max(0, nextUpdate.getTime() - now.getTime());

        // If we're using episode data or the track data hasn't changed,
        // poll every 10 seconds instead of waiting for the full duration
        if (!hasValidTrackData) {
          delay = 10000;
          self.logger.info('Using 10 second polling interval');
        } else {
          self.logger.info('Using calculated delay: ' + delay + 'ms');
        }
        
        self.nowPlayingTimer = setTimeout(function() {
          self.fetchNowPlaying();
        }, delay);
      } catch (error) {
        self.logger.error('Error processing now playing data: ' + error.message);
        self.logger.error('Error stack: ' + error.stack);
        if (response && response.body) {
          self.logger.error('Response body that caused error: ' + response.body);
          self.logger.error('Response body type: ' + typeof response.body);
          if (typeof response.body === 'object') {
            self.logger.error('Response body keys: ' + Object.keys(response.body));
          }
        }
        // Retry in 10 seconds on error
        self.nowPlayingTimer = setTimeout(function() {
          self.fetchNowPlaying();
        }, 10000);
      }
    });
};

ControllerPlanetRockRadio.prototype.stop = function() {
  var self = this;
  var defer = libQ.defer();

  // Clear the now playing timer
  if (self.nowPlayingTimer) {
    clearTimeout(self.nowPlayingTimer);
    self.nowPlayingTimer = null;
  }

  // Stop MPD playback
  return self.mpdPlugin.sendMpdCommand('stop', [])
    .then(function() {
      return self.mpdPlugin.sendMpdCommand('clear', []);
    })
    .then(function() {
      self.state.status = 'stop';
      self.commandRouter.servicePushState(self.state, self.serviceName);
    });
};

ControllerPlanetRockRadio.prototype.pause = function() {
  var self = this;
  var defer = libQ.defer();

  self.commandRouter.volumioPause();

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

  self.commandRouter.volumioSeek(position);

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

  self.commandRouter.volumioPrevious();

  return defer.promise;
}; 
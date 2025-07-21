/* eslint-disable promise/prefer-await-to-then */
'use strict';

const libQ = require('kew');
const fs = require('fs-extra');
const AuthManager = require('./src/AuthManager');
const StationManager = require('./src/StationManager');
const StreamingProxy = require('./src/StreamingProxy');

module.exports = ControllerPlanetRadio;

const ControllerPlanetRadio = function (context) {
  const self = this;

  self.context = context;
  self.commandRouter = this.context.coreCommand;
  self.logger = this.context.logger;
  self.state = {};
  self.stateMachine = self.commandRouter.stateMachine;
  self.authManager = new AuthManager(self.logger);
  self.stationManager = new StationManager(self.logger);

  // Streaming proxy will be created based on stream type
  self.streamingProxy = null;
  self.currentStationInfo = null; // Will store station info including code, name, albumart

  // Metadata delay handling
  self.metadataUpdateTimer = null;
  self.isFirstMetadataUpdate = true;

  self.logger.info('ControllerPlanetRadio::constructor');
};

ControllerPlanetRadio.prototype.onVolumioStart = function () {
  const self = this;
  self.configFile = this.commandRouter.pluginManager.getConfigurationFile(this.context, 'config.json');
  self.getConf(self.configFile);
  return libQ.resolve();
};

ControllerPlanetRadio.prototype.getConfigurationFiles = function () {
  return ['config.json'];
};

ControllerPlanetRadio.prototype.onStart = function () {
  const self = this;
  self.mpdPlugin = this.commandRouter.pluginManager.getPlugin('music_service', 'mpd');
  self.serviceName = 'planet_radio';

  self.addToBrowseSources();
  return libQ.resolve();
};

ControllerPlanetRadio.prototype.onStop = function () {
  const self = this;
  self.logger.info('Plugin stopping - cleaning up all resources');

  // Clear metadata timer
  if (self.metadataUpdateTimer) {
    clearTimeout(self.metadataUpdateTimer);
    self.metadataUpdateTimer = null;
  }

  // Stop the streaming proxy
  if (self.streamingProxy) {
    self.streamingProxy.stop();
  }

  // Reset UI state
  self.resetUIState();

  self.logger.info('Plugin cleanup completed');
  return libQ.resolve();
};

ControllerPlanetRadio.prototype.onRestart = function () {
  return libQ.resolve();
};

ControllerPlanetRadio.prototype.getConf = function (configFile) {
  const self = this;
  self.config = new (require('v-conf'))();
  self.config.loadFile(configFile);
};

ControllerPlanetRadio.prototype.setConf = function (conf) {
  const self = this;

  // Update configuration with provided values
  if (conf) {
    Object.keys(conf).forEach(key => {
      self.config.set(key, conf[key]);
    });
  }

  self.config.saveFile();
};

ControllerPlanetRadio.prototype.getUIConfig = function () {
  const self = this;
  const defer = libQ.defer();
  const lang_code = this.commandRouter.sharedVars.get('language_code');

  self.commandRouter
    .i18nJson(`${__dirname}/i18n/strings_${lang_code}.json`, `${__dirname}/i18n/strings_en.json`, `${__dirname}/UIConfig.json`)
    .then(function (uiconf) {
      uiconf.sections[0].content[0].value = self.config.get('username');
      uiconf.sections[0].content[1].value = self.config.get('password');
      uiconf.sections[0].content[2].value = self.config.get('metadata_delay', 10);
      defer.resolve(uiconf);
    })
    .fail(function () {
      defer.reject(new Error());
    });

  return defer.promise;
};

ControllerPlanetRadio.prototype.getRadioI18nString = function (key) {
  const lang_code = this.commandRouter.sharedVars.get('language_code');
  const i18n_strings = fs.readJsonSync(`${__dirname}/i18n/strings_${lang_code}.json`);
  return i18n_strings[key];
};

ControllerPlanetRadio.prototype.addToBrowseSources = function () {
  const self = this;
  self.logger.info('Adding Planet Radio to browse sources');
  self.commandRouter.volumioAddToBrowseSources({
    name: self.getRadioI18nString('PLUGIN_NAME'),
    uri: 'planetradio',
    plugin_type: 'music_service',
    plugin_name: 'planet_radio',
    albumart: '/albumart?sourceicon=music_service/planet_radio/assets/planet_radio.webp',
  });
  self.logger.info('Planet Radio added to browse sources');
};

ControllerPlanetRadio.prototype.handleBrowseUri = function (curUri) {
  const self = this;
  const defer = libQ.defer();

  self.logger.info(`handleBrowseUri called with URI: ${curUri}`);

  if (curUri.startsWith('planetradio/')) {
    // User selected a related station, fetch its info and resolve stream URL
    const stationCode = curUri.split('/')[1];

    // Use StationManager to get station info and create playable item
    self.stationManager
      .getStationInfo(stationCode)
      .then(function (stationInfo) {
        // Return a single playable item
        const item = {
          service: self.serviceName,
          type: 'mywebradio',
          title: stationInfo.name,
          artist: stationInfo.name,
          album: '',
          icon: 'fa fa-music',
          uri: `planetradio/${stationCode}`, // Use custom URI for on-demand resolution
          streamType: 'aac', // Will be resolved in explodeUri
          albumart: stationInfo.albumart,
        };
        defer.resolve({
          navigation: {
            prev: { uri: 'planetradio' },
            lists: [
              {
                availableListViews: ['list', 'grid'],
                title: stationInfo.name,
                items: [item],
              },
            ],
          },
        });
      })
      .catch(function (error) {
        self.logger.error(`Failed to resolve station info: ${error}`);
        self.commandRouter.pushToastMessage('error', self.getRadioI18nString('PLUGIN_NAME'), self.getRadioI18nString('ERROR_STREAMING'));
        defer.reject(error);
      });
    return defer.promise;
  } else if (curUri === 'planetradio') {
    self
      .getRootContent()
      .then(function (response) {
        defer.resolve(response);
      })
      .fail(function (error) {
        self.logger.error(`ControllerPlanetRadio::handleBrowseUri failed: ${error}`);
        defer.reject(error);
      });
  } else {
    defer.reject(new Error('Invalid URI'));
  }

  return defer.promise;
};

ControllerPlanetRadio.prototype.updateConfig = function (data) {
  const self = this;
  const defer = libQ.defer();
  let configUpdated = false;

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
    self.authManager.clearAuth();

    // Save the configuration to file
    self.config.saveFile();
    self.logger.info('Configuration updated and saved');
  }

  defer.resolve();
  return defer.promise;
};

ControllerPlanetRadio.prototype.authenticate = function () {
  const self = this;
  const defer = libQ.defer();

  // Check if we have credentials
  const username = self.config.get('username');
  const password = self.config.get('password');

  if (!username || !password) {
    self.commandRouter.pushToastMessage('error', self.getRadioI18nString('PLUGIN_NAME'), self.getRadioI18nString('ERROR_NO_CREDENTIALS'));
    defer.reject(new Error(self.getRadioI18nString('ERROR_NO_CREDENTIALS')));
    return defer.promise;
  }

  // Use AuthManager to handle authentication
  self.authManager
    .authenticate(username, password)
    .then(userId => {
      defer.resolve(userId);
    })
    .catch(error => {
      self.logger.error(`Authentication failed: ${error.message}`);
      self.commandRouter.pushToastMessage('error', self.getRadioI18nString('PLUGIN_NAME'), self.getRadioI18nString('ERROR_INVALID_CREDENTIALS'));
      defer.reject(new Error(self.getRadioI18nString('ERROR_INVALID_CREDENTIALS')));
    });

  return defer.promise;
};

ControllerPlanetRadio.prototype.getRootContent = function () {
  const self = this;
  const defer = libQ.defer();

  // Use StationManager to get stations
  self.stationManager
    .getStations()
    .then(function (stations) {
      defer.resolve({
        navigation: {
          prev: { uri: 'music' },
          lists: [
            {
              availableListViews: ['list', 'grid'],
              title: self.getRadioI18nString('PLUGIN_NAME'),
              items: stations,
            },
          ],
        },
      });
    })
    .catch(function (error) {
      self.logger.error(`Failed to get root content: ${error}`);
      self.commandRouter.pushToastMessage('error', self.getRadioI18nString('PLUGIN_NAME'), self.getRadioI18nString('ERROR_STREAMING'));
      defer.reject(error);
    });

  return defer.promise;
};

ControllerPlanetRadio.prototype.explodeUri = function (uri) {
  const self = this;
  const defer = libQ.defer();

  self.logger.info(`explodeUri called with URI: ${uri}`);

  if (uri.startsWith('planetradio/')) {
    const stationCode = uri.split('/')[1];

    // Use StationManager to get station info
    self.stationManager
      .getStationInfo(stationCode)
      .then(function (stationInfo) {
        const track = {
          uri,
          service: self.serviceName,
          type: 'webradio',
          trackType: 'webradio',
          title: stationInfo.name,
          artist: stationInfo.name,
          albumart: stationInfo.albumart || '/albumart?sourceicon=music_service/planet_radio/assets/planet_radio.webp',
          duration: 0,
        };

        defer.resolve(track);
      })
      .catch(function (error) {
        self.logger.error(`Failed to explode URI: ${error}`);
        self.commandRouter.pushToastMessage('error', self.getRadioI18nString('PLUGIN_NAME'), self.getRadioI18nString('ERROR_STREAMING'));
        defer.reject(error);
      });
  } else {
    defer.reject(new Error('Invalid URI format'));
  }

  return defer.promise;
};

ControllerPlanetRadio.prototype.clearAddPlayTrack = function (track) {
  const self = this;

  self.commandRouter.logger.info('ControllerPlanetRadio::clearAddPlayTrack');

  // Stop any existing streaming proxy
  if (self.streamingProxy) {
    self.streamingProxy.stop();
  }

  // First authenticate, then get streaming URL with parameters and start proxy
  self
    .authenticate()
    .then(function (_userId) {
    
      // Extract station code from track.uri if possible (e.g., planetradio/[stationCode])
      let stationCode = 'pln'; // default
      if (track && track.uri && track.uri.startsWith('planetradio/')) {
        stationCode = track.uri.split('/')[1];
      }

      // Get station info and store it
      return self.stationManager.getStationInfo(stationCode)
        .then(function (stationInfo) {
          self.currentStationInfo = stationInfo;
          return self.stationManager.getStreamingURL(stationCode);
        });
    })
    .then(function (streamUrl) {

      // Create the appropriate streaming proxy using the factory method
      self.streamingProxy = StreamingProxy.createProxy(streamUrl, self.logger, self.addAuthParamsToStreamURL.bind(self));

      // Set up metadata callback for the streaming proxy
      self.streamingProxy.setMetadataCallback(function (metadata) {
        self.pushSongState(metadata);
      });

      return self.streamingProxy.startProxyServer(streamUrl, self.currentStationInfo.code);
    })
    .then(function () {
      // Update track URI to use local proxy
      track.uri = self.streamingProxy.getLocalStreamUrl();

      return self.mpdPlugin.sendMpdCommand('stop', []);
    })
    .then(function () {
      return self.mpdPlugin.sendMpdCommand('clear', []);
    })
    .then(function () {
      return self.mpdPlugin.sendMpdCommand(`add "${track.uri}"`, []);
    })
    .then(function () {
      return self.mpdPlugin.sendMpdCommand('consume 1', []);
    })
    .then(function () {
      self.commandRouter.pushToastMessage('info', self.getRadioI18nString('PLUGIN_NAME'), self.getRadioI18nString('WAIT_FOR_RADIO_CHANNEL'));

      return self.mpdPlugin.sendMpdCommand('play', []);
    })
    .then(function () {
      self.state.status = 'play';
      self.commandRouter.servicePushState(self.state, self.serviceName);
      return libQ.resolve();
    })
    .fail(function (e) {
      self.logger.error(`Failed to start playback: ${e}`);
      self.commandRouter.pushToastMessage('error', self.getRadioI18nString('PLUGIN_NAME'), self.getRadioI18nString('ERROR_STREAMING'));
      return libQ.reject(new Error(self.getRadioI18nString('ERROR_STREAMING')));
    });
};

ControllerPlanetRadio.prototype.pushSongState = function (metadata) {
  const self = this;

  // Clear existing timer
  if (self.metadataUpdateTimer) {
    clearTimeout(self.metadataUpdateTimer);
  }

  // Get metadata delay from config
  const metadataDelay = self.config.get('metadata_delay', 10);

  // Set delay for metadata update
  self.metadataUpdateTimer = setTimeout(async () => {
    self.logger.info('pushSongState called. Fetching MPD status...');
    try {
      await self.pushSongStateImmediate(metadata);
    } catch {
      // Ignore catch
    }
  }, metadataDelay * 1000);
};

ControllerPlanetRadio.prototype.pushSongStateImmediate = async function (metadata) {
  const self = this;

  const planetRockState = {
    status: 'play',
    service: self.serviceName,
    type: 'webradio',
    trackType: 'webradio',
    radioType: 'planetrock',
    albumart: metadata.albumart || '/albumart?sourceicon=music_service/planet_radio/assets/planet_radio.webp',
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
    channels: 2,
  };

  try {
    // Get MPD status to get actual audio format
    const status = await self.mpdPlugin.sendMpdCommand('status', []);
    self.logger.info(`MPD status command returned. Response received: ${JSON.stringify(status, null, 2)}`);

    if (status) {
      self.logger.info('Parsing MPD status for audio info.');
      // Handle samplerate from 'audio' string (e.g., "44100:f:2")
      if (typeof status.audio === 'string') {
        const audioParts = status.audio.split(':');
        if (audioParts.length > 0 && audioParts[0]) {
          planetRockState.samplerate = `${audioParts[0]} Hz`;
          self.logger.info(`Parsed samplerate: ${planetRockState.samplerate}`);
        } 
      }

      // Handle bitrate
      if (status.bitrate) {
        planetRockState.bitrate = `${status.bitrate} kbps`;
        self.logger.info(`Parsed bitrate: ${planetRockState.bitrate}`);
      } 
    }
  } catch (error) {
    self.logger.error('Failed to get MPD status:', error);
    // Continue with basic metadata even if MPD status fails
  }

  // Update Volumio state with metadata (with or without MPD audio info)
  self.updateVolumioState(planetRockState);
};

ControllerPlanetRadio.prototype.stop = function () {
  const self = this;

  // Stop MPD playback first
  return self.mpdPlugin
    .sendMpdCommand('stop', [])
    .then(function () {
      return self.mpdPlugin.sendMpdCommand('clear', []);
    })
    .then(function () {
      self.logger.info('MPD playback stopped successfully');
      return libQ.resolve();
    })
    .fail(function (error) {
      self.logger.error(`Error stopping MPD playback: ${error}`);
      return libQ.resolve();
    })
    .fin(function () {
      // Always stop the streaming proxy and reset UI state, regardless of MPD command success/failure
      if (self.streamingProxy) {
        self.streamingProxy.stop();
      }
      self.updateVolumioState({ status: 'stop' });
      self.resetUIState();
    });
};

ControllerPlanetRadio.prototype.pause = function () {
  const self = this;
  const defer = libQ.defer();

  self.commandRouter.volumioStop();

  return defer.promise;
};

ControllerPlanetRadio.prototype.resume = function () {
  const self = this;
  const defer = libQ.defer();

  self.commandRouter.volumioPlay();

  return defer.promise;
};

ControllerPlanetRadio.prototype.seek = function (_position) {
  const defer = libQ.defer();
  return defer.promise;
};

ControllerPlanetRadio.prototype.next = function () {
  const defer = libQ.defer();
  return defer.promise;
};

ControllerPlanetRadio.prototype.previous = function () {
  const defer = libQ.defer();
  return defer.promise;
};

ControllerPlanetRadio.prototype.addAuthParamsToStreamURL = function (streamUrl) {
  const self = this;
  const userId = self.authManager.getUserId();
  return self.stationManager.addAuthParameters(streamUrl, userId);
};

/**
 * Update Volumio state and queue item with the provided state object
 * @param {Object} stateObject - The state object to apply
 */
ControllerPlanetRadio.prototype.updateVolumioState = function (stateObject) {
  const self = this;

  // Update self.state with the provided state object
  self.state = { ...self.state, ...stateObject };

  // Workaround to allow state to be pushed when not in a volatile state
  const vState = self.commandRouter.stateMachine.getState();
  const queueItem = self.commandRouter.stateMachine.playQueue.arrayQueue[vState.position];

  // Update queue item with state properties
  queueItem.name = self.state.title || '';
  queueItem.artist = self.state.artist || '';
  queueItem.albumart = self.state.albumart || '';
  queueItem.trackType = self.state.trackType || 'webradio';
  queueItem.duration = self.state.duration || 0;
  queueItem.samplerate = self.state.samplerate || '-';
  queueItem.bitrate = self.state.bitrate || '-';
  queueItem.channels = self.state.channels || 2;

  // Reset volumio internal timer
  self.commandRouter.stateMachine.currentSeek = 0;
  self.commandRouter.stateMachine.playbackStart = Date.now();
  self.commandRouter.stateMachine.currentSongDuration = 0;
  self.commandRouter.stateMachine.askedForPrefetch = false;
  self.commandRouter.stateMachine.prefetchDone = false;
  self.commandRouter.stateMachine.simulateStopStartDone = false;

  // Volumio push state
  self.commandRouter.servicePushState(self.state, self.serviceName);
};

ControllerPlanetRadio.prototype.resetUIState = function () {
  const self = this;
  self.logger.info('Resetting UI state');

  // Stop and clear streaming proxy
  if (self.streamingProxy) {
    self.streamingProxy.stop();
    self.streamingProxy = null;
  }

  // Use stored station info for UI display
  if (self.currentStationInfo) {
    // Reset UI state using the centralized update function with stored station info
    self.updateVolumioState({
      status: 'stop',
      albumart: self.currentStationInfo.albumart || '/albumart?sourceicon=music_service/planet_radio/assets/planet_radio.webp',
      artist: 'Planet Radio',
      title: self.currentStationInfo.name || 'Planet Rock',
      trackType: 'webradio',
      duration: 0,
      samplerate: '-',
      bitrate: '-'
    });
  } 

  // Reset streaming state after updating UI
  self.currentStationInfo = null;

  self.logger.info('UI state reset completed');
};

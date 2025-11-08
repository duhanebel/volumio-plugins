'use strict';
/* eslint-disable promise/prefer-await-to-then */

const libQ = require('kew');
const fs = require('fs-extra');
const AuthManager = require('./src/AuthManager');
const StationManager = require('./src/StationManager');
const StreamPlayerFactory = require('./src/StreamPlayerFactory');
const MetadataFetcher = require('./src/MetadataFetcher');


// Constants
const DEFAULT_STATION_CODE = 'pln';
const DEFAULT_ALBUM_ART = '/albumart?sourceicon=music_service/planet_radio/assets/planet_radio.webp';
const UNKNOWN_SAMPLERATE = '-';
const UNKNOWN_BITRATE = '-';
const STEREO_CHANNELS = 2;
const UNKNOWN_DURATION = 0;
const SERVICE_NAME = 'planet_radio';
const RADIO_TYPE = 'planetrock';
const TRACK_TYPE = 'webradio';

const ControllerPlanetRadio = function (context) {
  const self = this;

  self.context = context;
  self.commandRouter = this.context.coreCommand;

  self.logger = {
    info: (msg, ...args) => this.context.logger.info(`[PlanetRadio] ${msg}`, ...args),
    warn: (msg, ...args) => this.context.logger.warn(`[PlanetRadio] ${msg}`, ...args),
    error: (msg, ...args) => this.context.logger.error(`[PlanetRadio] ${msg}`, ...args),
    debug: (msg, ...args) => this.context.logger.debug(`[PlanetRadio] ${msg}`, ...args)
  };
  
  self.authManager = new AuthManager(self.logger);
  self.stationManager = new StationManager(self.logger);
  self.state = {};

  self.streamPlayer = null;
  self.currentStationInfo = null; // Will store station info including code, name, albumart

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
  self.serviceName = SERVICE_NAME;

  self.addToBrowseSources();
  return libQ.resolve();
};

ControllerPlanetRadio.prototype.onStop = function () {
  const self = this;
  self.logger.info('Plugin stopping - cleaning up all resources');

  self.commandRouter.volumioStop();
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

  self.logger.info('getUIConfig called, language code:', lang_code);

  // Ensure config is loaded before proceeding
  if (!self.config) {
    self.logger.warn('Configuration not yet loaded, loading now...');
    self.configFile = this.commandRouter.pluginManager.getConfigurationFile(this.context, 'config.json');
    self.getConf(self.configFile);
  }

  self.logger.info('Loading UI configuration files...');
  self.commandRouter
    .i18nJson(`${__dirname}/i18n/strings_${lang_code}.json`, `${__dirname}/i18n/strings_en.json`, `${__dirname}/UIConfig.json`)
    .then(function (uiconf) {

      // Ensure config values exist, use defaults if not
      const username = self.config.get('username') || '';
      const password = self.config.get('password') || '';

      // Update the UI config with current values
      uiconf.sections[0].content[0].value = username;
      uiconf.sections[0].content[1].value = password;

      defer.resolve(uiconf);
    })
    .fail(function (error) {
      const errorMessage = error.message || 'Unknown error occurred';
      self.logger.error(`Failed to get UI config: ${errorMessage}`);

      // Log additional context for debugging
      if (error.stack) {
        self.logger.error('UI config error stack trace:', error.stack);
      }

      // Try to load a basic UI config as fallback
      self.logger.warn('Attempting to load basic UI config as fallback...');
      try {
        const basicConfig = fs.readJsonSync(`${__dirname}/UIConfig.json`);

        // Ensure config values exist, use defaults if not
        const username = self.config.get('username') || '';

        // Update the UI config with current values
        basicConfig.sections[0].content[0].value = username;

        self.logger.info('Basic UI config loaded successfully as fallback');
        defer.resolve(basicConfig);
      } catch (fallbackError) {
        self.logger.error('Fallback UI config also failed:', fallbackError.message);
        defer.reject(new Error('Failed to load UI configuration'));
      }
    });

  return defer.promise;
};

ControllerPlanetRadio.prototype._getRadioI18nString = function (key) {
  const lang_code = this.commandRouter.sharedVars.get('language_code');
  const i18n_strings = fs.readJsonSync(`${__dirname}/i18n/strings_${lang_code}.json`);
  return i18n_strings[key];
};

ControllerPlanetRadio.prototype.addToBrowseSources = function () {
  const self = this;
  self.logger.info('Adding Planet Radio to browse sources');
  self.commandRouter.volumioAddToBrowseSources({
    name: self._getRadioI18nString('PLUGIN_NAME'),
    uri: 'planetradio',
    plugin_type: 'music_service',
    plugin_name: 'planet_radio',
    albumart: DEFAULT_ALBUM_ART,
  });
};

ControllerPlanetRadio.prototype.handleBrowseUri = function (curUri) {
  const self = this;

  self.logger.info(`handleBrowseUri called with URI: ${curUri}`);

  if (curUri.startsWith('planetradio/')) {
    // User selected a related station, fetch its info and resolve stream URL
    const stationCode = curUri.split('/')[1];

    const defer = libQ.defer();

    self.stationManager.getStationInfo(stationCode)
      .then(stationInfo => {
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
          albumart: stationInfo.albumart || DEFAULT_ALBUM_ART,
        };

        defer.resolve(item);
      })
      .catch(error => {
        self.logger.error(`Failed to get station info: ${error.message}`);
        defer.reject(error);
      });

    return defer.promise;
  } else if (curUri === 'planetradio') {
    // getRootContent() already returns a libQ promise, so we can use it directly
    return self.getRootContent();
  } else {
    // Return rejected promise for invalid URI
    const defer = libQ.defer();
    defer.reject(new Error('Invalid URI'));
    return defer.promise;
  }
};

ControllerPlanetRadio.prototype.updateConfig = function (data) {
  const self = this;
  const defer = libQ.defer();

  try {
    // Ensure config is loaded before proceeding
    if (!self.config) {
      self.logger.warn('Configuration not yet loaded, loading now...');
      self.configFile = this.commandRouter.pluginManager.getConfigurationFile(this.context, 'config.json');
      self.getConf(self.configFile);
    }

    let configUpdated = false;

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
      self.authManager.clearAuth();

      // Save the configuration to file
      self.config.saveFile();
      self.logger.info('Configuration updated and saved');
    }

    defer.resolve({});
  } catch (error) {
    self.logger.error(`Error updating configuration: ${error.message}`);
    defer.reject(error);
  }

  return defer.promise;
};

ControllerPlanetRadio.prototype._authenticate = async function () {
  const self = this;

  // Check if we have credentials
  const username = self.config.get('username');
  const password = self.config.get('password');

  if (!username || !password) {
    self.commandRouter.pushToastMessage('error', self._getRadioI18nString('PLUGIN_NAME'), self._getRadioI18nString('ERROR_NO_CREDENTIALS'));
    throw new Error(self._getRadioI18nString('ERROR_NO_CREDENTIALS'));
  }

  const userId = await self.authManager.authenticate(username, password);
  self.logger.info(`AuthManager authentication successful, user ID: ${userId}`);
  return userId;
};

ControllerPlanetRadio.prototype.getRootContent = function () {
  const self = this;
  const defer = libQ.defer();

  self.logger.info('Getting root content - fetching stations...');

  self.stationManager.getStations()
    .then(stations => {
      self.logger.info(`Stations received in getRootContent: ${stations.length} stations`);
      const result = {
        navigation: {
          prev: { uri: 'music' },
          lists: [
            {
              availableListViews: ['list', 'grid'],
              title: self._getRadioI18nString('PLUGIN_NAME'),
              items: stations,
            },
          ],
        },
      };
      self.logger.info('Root content result created successfully');
      defer.resolve(result);
    })
    .catch(error => {
      const errorMessage = error.message || 'Unknown error occurred';
      self.logger.error(`Failed to get root content: ${errorMessage}`);

      // Log additional context for debugging
      if (error.stack) {
        self.logger.error('Error stack trace:', error.stack);
      }

      self.commandRouter.pushToastMessage('error', self._getRadioI18nString('PLUGIN_NAME'), self._getRadioI18nString('ERROR_STREAMING'));

      defer.reject(error);
    });

  return defer.promise;
};

ControllerPlanetRadio.prototype.explodeUri = function (uri) {
  const self = this;

  if (uri.startsWith('planetradio/')) {
    const stationCode = uri.split('/')[1];
    const defer = libQ.defer();

    self.logger.info(`Extracted station code: ${stationCode}`);

    self.stationManager.getStationInfo(stationCode)
      .then(stationInfo => {
        self.logger.info(`Station info received in explodeUri: ${JSON.stringify(stationInfo)}`);
        const track = {
          uri,
          service: self.serviceName,
          type: TRACK_TYPE,
          trackType: TRACK_TYPE,
          title: stationInfo.name,
          artist: stationInfo.name,
          albumart: stationInfo.albumart || DEFAULT_ALBUM_ART,
          duration: UNKNOWN_DURATION,
        };

        self.logger.info(`Created track object: ${JSON.stringify(track)}`);
        defer.resolve(track);
      })
      .catch(error => {
        const errorMessage = error.message || 'Unknown error occurred';
        self.logger.error(`Failed to explode URI ${uri}: ${errorMessage}`);

        // Log additional context for debugging
        if (error.stack) {
          self.logger.error('Error stack trace:', error.stack);
        }

        self.commandRouter.pushToastMessage('error', self._getRadioI18nString('PLUGIN_NAME'), self._getRadioI18nString('ERROR_STREAMING'));

        defer.reject(error);
      });

    return defer.promise;
  } else {
    // Return rejected promise for invalid URI
    const defer = libQ.defer();
    defer.reject(new Error('Invalid URI format'));
    return defer.promise;
  }
};

ControllerPlanetRadio.prototype.clearAddPlayTrack = function (track) {
  const self = this;
  const defer = libQ.defer();

  // Stop any existing stream player
  if (self.streamPlayer) {
    try {
      self.logger.info('Stopping existing stream player...');
      self.streamPlayer.stop();
      self.streamPlayer = null;
    } catch (error) {
      self.logger.warn('Error stopping existing stream player:', error.message);
      // Force cleanup even if stop fails
      self.streamPlayer = null;
    }
  }

  // First authenticate, then get streaming URL with parameters and start proxy
  self._authenticate()
    .then(userId => {
      self.logger.info(`Authentication successful, proceeding to get station info... User ID: ${userId}`);
      // Extract station code from track.uri if possible (e.g., planetradio/[stationCode])
      let stationCode = DEFAULT_STATION_CODE; // default
      if (track && track.uri && track.uri.startsWith('planetradio/')) {
        stationCode = track.uri.split('/')[1];
      }

      self.logger.info(`Getting station info for station code: ${stationCode}`);

      // Get station info and store it
      return self.stationManager.getStationInfo(stationCode);
    })
    .then(stationInfo => {
      self.logger.info(`Station info received: ${JSON.stringify(stationInfo)}`);
      self.currentStationInfo = stationInfo;

      // Get streaming URL
      return self.stationManager.getStreamingURL(stationInfo.code);
    })
    .then(streamUrl => {
      self.logger.info(`Streaming URL received: ${streamUrl}`);

      // Store streamUrl for later use
      self.currentStreamUrl = streamUrl;

      // Create metadata fetcher with the station code
      const metadataFetcher = new MetadataFetcher(self.logger, self.currentStationInfo.code);
      metadataFetcher.setMetadataCallback(function (metadata) {
        self.pushSongState(metadata);
      });

      // Create the appropriate stream player using the factory method
      self.streamPlayer = StreamPlayerFactory.createPlayer(
        streamUrl, 
        self.mpdPlugin, 
        self.logger, 
        self._addAuthParamsToStreamURL.bind(self),
        metadataFetcher
      );

      return self.streamPlayer.start();
    })
    .then(streamUri => {
      // The stream player returns the appropriate URI for MPD
      track.uri = streamUri;
      self.logger.info(`Stream player ready, track URI set to: ${track.uri}`);

      // Show wait message for radio channel
      self.commandRouter.pushToastMessage('info', self._getRadioI18nString('PLUGIN_NAME'), self._getRadioI18nString('WAIT_FOR_RADIO_CHANNEL'));

      // Update state to indicate playback has started
      self.state.status = 'play';
      self.commandRouter.servicePushState(self.state, self.serviceName);
      self.logger.info('Playback started successfully');

      defer.resolve();
    })
    .catch(error => {
      const errorMessage = error.message || 'Unknown error occurred';
      self.logger.error(`Failed to start playback: ${errorMessage}`);

      self.commandRouter.pushToastMessage('error', self._getRadioI18nString('PLUGIN_NAME'), self._getRadioI18nString('ERROR_STREAMING'));
      defer.reject(new Error(self._getRadioI18nString('ERROR_STREAMING')));
    });

  return defer.promise;
};



ControllerPlanetRadio.prototype.pushSongState = function (metadata) {
  const self = this;
  const defer = libQ.defer();

  const planetRockState = {
    status: 'play',
    service: self.serviceName,
    type: TRACK_TYPE,
    trackType: TRACK_TYPE,
    radioType: RADIO_TYPE,
    albumart: metadata.albumart || DEFAULT_ALBUM_ART,
    name: metadata.title,
    title: metadata.title,
    artist: metadata.artist,
    duration: UNKNOWN_DURATION,
    streaming: true,
    disableUiControls: true,
    seek: false,
    pause: false,
    stop: true,
    samplerate: UNKNOWN_SAMPLERATE,
    bitrate: UNKNOWN_BITRATE,
    channels: STEREO_CHANNELS,
  };

  // Get MPD status to get actual audio format
  self.mpdPlugin.sendMpdCommand('status', [])
    .then(status => {
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

      // Update Volumio state with metadata (with or without MPD audio info)
      self._updateVolumioState(planetRockState);
      defer.resolve();
    })
    .catch(error => {
      self.logger.warn('Failed to get MPD status, continuing with basic metadata:', error.message);
      // Update Volumio state with metadata (with or without MPD audio info)
      self._updateVolumioState(planetRockState);
      defer.resolve();
    });

  return defer.promise;
};

ControllerPlanetRadio.prototype.stop = function () {
  const self = this;
  const defer = libQ.defer();

  // Stop MPD playback first

  if (self.streamPlayer) {
    try {
      self.streamPlayer.stop();
    } catch (error) {
      self.logger.warn('Error stopping stream player during cleanup:', error.message);
    } finally {
      self.logger.info('MPD playback stopped successfully');
      self._updateVolumioState({ status: 'stop' });
      self._resetUIState();
      defer.resolve();
    }
  }

  return defer.promise;
};

ControllerPlanetRadio.prototype.pause = function () {
  const self = this;

  self.commandRouter.volumioStop();

  return libQ.resolve();
};

ControllerPlanetRadio.prototype.resume = function () {
  const self = this;

  self.commandRouter.volumioPlay();

  return libQ.resolve();
};

ControllerPlanetRadio.prototype.seek = function (_position) {
  return libQ.resolve();
};

ControllerPlanetRadio.prototype.next = function () {
  return libQ.resolve();
};

ControllerPlanetRadio.prototype.previous = function () {
  return libQ.resolve();
};

ControllerPlanetRadio.prototype._addAuthParamsToStreamURL = function (streamUrl) {
  const self = this;
  const userId = self.authManager.getUserId();

  self.logger.info(`Adding auth parameters to stream URL for user ID: ${userId}`);

  if (!userId) {
    self.logger.error('No user ID available for authentication');
    return streamUrl; // Return original URL if no auth
  }

  if (!streamUrl) {
    self.logger.error('No stream URL provided for authentication');
    return streamUrl;
  }

  try {
    // Call the synchronous method directly
    const result = self.stationManager.addAuthParameters(streamUrl, userId);
    this.logger.info(`Authenticated stream URL: ${result.toString()}`);
    return result;
  } catch (error) {
    self.logger.error(`Error in addAuthParamsToStreamURL: ${error.message}`);
    return streamUrl; // Return original URL if error
  }
};

/**
 * Update Volumio state and queue item with the provided state object
 * @param {Object} stateObject - The state object to apply
 */
ControllerPlanetRadio.prototype._updateVolumioState = function (stateObject) {
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
  queueItem.trackType = self.state.trackType || TRACK_TYPE;
  queueItem.duration = self.state.duration || UNKNOWN_DURATION;
  queueItem.samplerate = self.state.samplerate || UNKNOWN_SAMPLERATE;
  queueItem.bitrate = self.state.bitrate || UNKNOWN_BITRATE;
  queueItem.channels = self.state.channels || STEREO_CHANNELS;

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

ControllerPlanetRadio.prototype._resetUIState = function () {
  const self = this;
  
  // Use stored station info for UI display
  if (self.currentStationInfo) {
    // Reset UI state using the centralized update function with stored station info
    self._updateVolumioState({
      status: 'stop',
      albumart: self.currentStationInfo.albumart || DEFAULT_ALBUM_ART,
      artist: 'Planet Radio',
      title: self.currentStationInfo.name || 'Planet Rock',
      trackType: TRACK_TYPE,
      duration: UNKNOWN_DURATION,
      samplerate: UNKNOWN_SAMPLERATE,
      bitrate: UNKNOWN_BITRATE,
    });
  }

  // Reset streaming state after updating UI
  self.currentStationInfo = null;
};

module.exports = ControllerPlanetRadio;

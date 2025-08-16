'use strict';

const libQ = require('kew');
const fs = require('fs-extra');
const AuthManager = require('./src/AuthManager');
const StationManager = require('./src/StationManager');
const StreamingProxyFactory = require('./src/StreamingProxyFactory');

// Constants
const DEFAULT_STATION_CODE = 'pln';
const DEFAULT_METADATA_DELAY = 10;
const DEFAULT_ALBUM_ART = '/albumart?sourceicon=music_service/planet_radio/assets/planet_radio.webp';
const UNKNOWN_SAMPLERATE = '-';
const UNKNOWN_BITRATE = '-';
const STEREO_CHANNELS = 2;
const UNKNOWN_DURATION = 0;
const SERVICE_NAME = 'planet_radio';
const RADIO_TYPE = 'planetrock';
const TRACK_TYPE = 'webradio';

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
  self.serviceName = SERVICE_NAME;

  self.addToBrowseSources();
  return libQ.resolve();
};

ControllerPlanetRadio.prototype.onStop = function () {
  const self = this;
  self.logger.info('Plugin stopping - cleaning up all resources');

  // Use centralized cleanup method
  self._cleanupResources();

  self.logger.info('Plugin cleanup completed');
  return libQ.resolve();
};

/**
 * Centralized cleanup method for all plugin resources
 * @private
 */
ControllerPlanetRadio.prototype._cleanupResources = function () {
  const self = this;
  self.logger.info('Starting centralized resource cleanup');

  // Clear metadata timer
  if (self.metadataUpdateTimer) {
    try {
      clearTimeout(self.metadataUpdateTimer);
    } catch (error) {
      self.logger.warn('Error clearing metadata timer:', error.message);
    } finally {
      self.metadataUpdateTimer = null;
    }
  }

  // Stop the streaming proxy
  if (self.streamingProxy) {
    try {
      self.streamingProxy.stop();
    } catch (error) {
      self.logger.warn('Error stopping streaming proxy during cleanup:', error.message);
    } finally {
      self.streamingProxy = null;
    }
  }

  // Reset UI state
  try {
    self.resetUIState();
  } catch (error) {
    self.logger.warn('Error resetting UI state during cleanup:', error.message);
  }

  self.logger.info('Centralized resource cleanup completed');
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

ControllerPlanetRadio.prototype.getUIConfig = async function () {
  const self = this;
  const lang_code = this.commandRouter.sharedVars.get('language_code');

  try {
    const uiconf = await self.commandRouter.i18nJson(
      `${__dirname}/i18n/strings_${lang_code}.json`,
      `${__dirname}/i18n/strings_en.json`,
      `${__dirname}/UIConfig.json`
    );
    uiconf.sections[0].content[0].value = self.config.get('username');
    uiconf.sections[0].content[1].value = self.config.get('password');
    uiconf.sections[0].content[2].value = self.config.get('metadata_delay', DEFAULT_METADATA_DELAY);
    return uiconf;
  } catch (error) {
    const errorMessage = error.message || 'Unknown error occurred';
    self.logger.error(`Failed to get UI config: ${errorMessage}`);

    // Log additional context for debugging
    if (error.stack) {
      self.logger.error('UI config error stack trace:', error.stack);
    }

    throw new Error('Failed to load UI configuration');
  }
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
    albumart: DEFAULT_ALBUM_ART,
  });
  self.logger.info('Planet Radio added to browse sources');
};

ControllerPlanetRadio.prototype.handleBrowseUri = async function (curUri) {
  const self = this;

  self.logger.info(`handleBrowseUri called with URI: ${curUri}`);

  if (curUri.startsWith('planetradio/')) {
    // User selected a related station, fetch its info and resolve stream URL
    const stationCode = curUri.split('/')[1];

    try {
      // Use StationManager to get station info and create playable item
      const stationInfo = await self.stationManager.getStationInfo(stationCode);

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

      return {
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
      };
    } catch (error) {
      const errorMessage = error.message || 'Unknown error occurred';
      self.logger.error(`Failed to resolve station info for ${stationCode}: ${errorMessage}`);

      // Log additional context for debugging
      if (error.stack) {
        self.logger.error('Error stack trace:', error.stack);
      }

      self.commandRouter.pushToastMessage('error', self.getRadioI18nString('PLUGIN_NAME'), self.getRadioI18nString('ERROR_STREAMING'));
      throw error;
    }
  } else if (curUri === 'planetradio') {
    try {
      const response = await self.getRootContent();
      return response;
    } catch (error) {
      self.logger.error(`ControllerPlanetRadio::handleBrowseUri failed: ${error}`);
      throw error;
    }
  } else {
    throw new Error('Invalid URI');
  }
};

ControllerPlanetRadio.prototype.updateConfig = function (data) {
  const self = this;
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

  return libQ.resolve();
};

ControllerPlanetRadio.prototype.authenticate = async function () {
  const self = this;

  // Check if we have credentials
  const username = self.config.get('username');
  const password = self.config.get('password');

  if (!username || !password) {
    self.commandRouter.pushToastMessage('error', self.getRadioI18nString('PLUGIN_NAME'), self.getRadioI18nString('ERROR_NO_CREDENTIALS'));
    throw new Error(self.getRadioI18nString('ERROR_NO_CREDENTIALS'));
  }

  try {
    // Use AuthManager to handle authentication
    const userId = await self.authManager.authenticate(username, password);
    return userId;
  } catch (error) {
    const errorMessage = error.message || 'Unknown authentication error';
    self.logger.error(`Authentication failed: ${errorMessage}`);

    // Log additional context for debugging
    if (error.stack) {
      self.logger.error('Authentication error stack trace:', error.stack);
    }

    self.commandRouter.pushToastMessage('error', self.getRadioI18nString('PLUGIN_NAME'), self.getRadioI18nString('ERROR_INVALID_CREDENTIALS'));
    throw new Error(self.getRadioI18nString('ERROR_INVALID_CREDENTIALS'));
  }
};

ControllerPlanetRadio.prototype.getRootContent = async function () {
  const self = this;

  try {
    // Use StationManager to get stations
    const stations = await self.stationManager.getStations();

    return {
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
    };
  } catch (error) {
    const errorMessage = error.message || 'Unknown error occurred';
    self.logger.error(`Failed to get root content: ${errorMessage}`);

    // Log additional context for debugging
    if (error.stack) {
      self.logger.error('Error stack trace:', error.stack);
    }

    self.commandRouter.pushToastMessage('error', self.getRadioI18nString('PLUGIN_NAME'), self.getRadioI18nString('ERROR_STREAMING'));
    throw error;
  }
};

ControllerPlanetRadio.prototype.explodeUri = async function (uri) {
  const self = this;

  self.logger.info(`explodeUri called with URI: ${uri}`);

  if (uri.startsWith('planetradio/')) {
    const stationCode = uri.split('/')[1];

    try {
      // Use StationManager to get station info
      const stationInfo = await self.stationManager.getStationInfo(stationCode);

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

      return track;
    } catch (error) {
      const errorMessage = error.message || 'Unknown error occurred';
      self.logger.error(`Failed to explode URI ${uri}: ${errorMessage}`);

      // Log additional context for debugging
      if (error.stack) {
        self.logger.error('Error stack trace:', error.stack);
      }

      self.commandRouter.pushToastMessage('error', self.getRadioI18nString('PLUGIN_NAME'), self.getRadioI18nString('ERROR_STREAMING'));
      throw error;
    }
  } else {
    throw new Error('Invalid URI format');
  }
};

ControllerPlanetRadio.prototype.clearAddPlayTrack = async function (track) {
  const self = this;

  self.commandRouter.logger.info('ControllerPlanetRadio::clearAddPlayTrack');

  // Stop any existing streaming proxy
  if (self.streamingProxy) {
    self.streamingProxy.stop();
  }

  try {
    // First authenticate, then get streaming URL with parameters and start proxy
    await self.authenticate();

    // Extract station code from track.uri if possible (e.g., planetradio/[stationCode])
    let stationCode = DEFAULT_STATION_CODE; // default
    if (track && track.uri && track.uri.startsWith('planetradio/')) {
      stationCode = track.uri.split('/')[1];
    }

    // Get station info and store it
    const stationInfo = await self.stationManager.getStationInfo(stationCode);
    self.currentStationInfo = stationInfo;
    const streamUrl = await self.stationManager.getStreamingURL(stationCode);

    // Create the appropriate streaming proxy using the factory method
    self.streamingProxy = StreamingProxyFactory.createProxy(streamUrl, self.logger, self.addAuthParamsToStreamURL.bind(self));

    // Set up metadata callback for the streaming proxy
    self.streamingProxy.setMetadataCallback(function (metadata) {
      self.pushSongState(metadata);
    });

    await self.streamingProxy.startProxyServer(streamUrl, self.currentStationInfo.code);

    // Update track URI to use local proxy
    track.uri = self.streamingProxy.getLocalStreamUrl();

    await self.mpdPlugin.sendMpdCommand('stop', []);
    await self.mpdPlugin.sendMpdCommand('clear', []);
    await self.mpdPlugin.sendMpdCommand(`add "${track.uri}"`, []);
    await self.mpdPlugin.sendMpdCommand('consume 1', []);

    self.commandRouter.pushToastMessage('info', self.getRadioI18nString('PLUGIN_NAME'), self.getRadioI18nString('WAIT_FOR_RADIO_CHANNEL'));

    await self.mpdPlugin.sendMpdCommand('play', []);

    self.state.status = 'play';
    self.commandRouter.servicePushState(self.state, self.serviceName);
    return libQ.resolve();
  } catch (error) {
    const errorMessage = error.message || 'Unknown error occurred';
    self.logger.error(`Failed to start playback: ${errorMessage}`);

    // Log additional context for debugging
    if (error.stack) {
      self.logger.error('Error stack trace:', error.stack);
    }

    self.commandRouter.pushToastMessage('error', self.getRadioI18nString('PLUGIN_NAME'), self.getRadioI18nString('ERROR_STREAMING'));
    throw new Error(self.getRadioI18nString('ERROR_STREAMING'));
  }
};

ControllerPlanetRadio.prototype.pushSongState = function (metadata) {
  const self = this;

  // Clear existing timer
  if (self.metadataUpdateTimer) {
    clearTimeout(self.metadataUpdateTimer);
  }

  // Get metadata delay from config
  const metadataDelay = self.config.get('metadata_delay', DEFAULT_METADATA_DELAY);

  // Set delay for metadata update
  self.metadataUpdateTimer = setTimeout(async () => {
    self.logger.info('pushSongState called. Fetching MPD status...');
    try {
      await self.pushSongStateImmediate(metadata);
    } catch (error) {
      self.logger.warn('Non-critical error in pushSongState:', error.message);
      // Continue with basic metadata even if MPD status fails
    }
  }, metadataDelay * 1000);
};

ControllerPlanetRadio.prototype.pushSongStateImmediate = async function (metadata) {
  const self = this;

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
    self.logger.warn('Failed to get MPD status, continuing with basic metadata:', error.message);
    // Continue with basic metadata even if MPD status fails
  }

  // Update Volumio state with metadata (with or without MPD audio info)
  self.updateVolumioState(planetRockState);
};

ControllerPlanetRadio.prototype.stop = async function () {
  const self = this;

  try {
    // Stop MPD playback first
    await self.mpdPlugin.sendMpdCommand('stop', []);
    await self.mpdPlugin.sendMpdCommand('clear', []);
    self.logger.info('MPD playback stopped successfully');
  } catch (error) {
    self.logger.warn(`MPD playback stop command failed (non-critical): ${error.message}`);
    // Continue with cleanup even if MPD commands fail
  } finally {
    // Always perform cleanup regardless of MPD command success/failure
    self.updateVolumioState({ status: 'stop' });
    self._cleanupResources();
  }

  return libQ.resolve();
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

ControllerPlanetRadio.prototype.resetUIState = function () {
  const self = this;
  self.logger.info('Resetting UI state');

  // Stop and clear streaming proxy
  if (self.streamingProxy) {
    try {
      self.streamingProxy.stop();
    } catch (error) {
      self.logger.warn('Error stopping streaming proxy during reset:', error.message);
    } finally {
      self.streamingProxy = null;
    }
  }

  // Use stored station info for UI display
  if (self.currentStationInfo) {
    // Reset UI state using the centralized update function with stored station info
    self.updateVolumioState({
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

  self.logger.info('UI state reset completed');
};

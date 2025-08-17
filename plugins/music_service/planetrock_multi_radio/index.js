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

  // Initialize metadata timing flag
  self.isFirstTimeMetadata = true;

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

  self.isFirstTimeMetadata = true;

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
      self.logger.info('i18nJson loaded successfully, updating config values...');

      // Ensure config values exist, use defaults if not
      const username = self.config.get('username') || '';
      const password = self.config.get('password') || '';
      const metadataDelay = self.config.get('metadata_delay') || DEFAULT_METADATA_DELAY;

      self.logger.info(`Config values - username: ${username ? 'set' : 'not set'}, password: ${password ? 'set' : 'not set'}, metadataDelay: ${metadataDelay}`);

      // Update the UI config with current values
      uiconf.sections[0].content[0].value = username;
      uiconf.sections[0].content[1].value = password;
      uiconf.sections[0].content[2].value = metadataDelay;

      self.logger.info('UI config loaded successfully, resolving promise');
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
        const password = self.config.get('password') || '';
        const metadataDelay = self.config.get('metadata_delay') || DEFAULT_METADATA_DELAY;

        // Update the UI config with current values
        basicConfig.sections[0].content[0].value = username;
        basicConfig.sections[0].content[1].value = password;
        basicConfig.sections[0].content[2].value = metadataDelay;

        self.logger.info('Basic UI config loaded successfully as fallback');
        defer.resolve(basicConfig);
      } catch (fallbackError) {
        self.logger.error('Fallback UI config also failed:', fallbackError.message);
        defer.reject(new Error('Failed to load UI configuration'));
      }
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
    albumart: DEFAULT_ALBUM_ART,
  });
  self.logger.info('Planet Radio added to browse sources');
};

ControllerPlanetRadio.prototype.handleBrowseUri = function (curUri) {
  const self = this;

  self.logger.info(`handleBrowseUri called with URI: ${curUri}`);

  if (curUri.startsWith('planetradio/')) {
    // User selected a related station, fetch its info and resolve stream URL
    const stationCode = curUri.split('/')[1];

    // Use StationManager to get station info (now returns libQ promise directly)
    return self.stationManager
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
          albumart: stationInfo.albumart || DEFAULT_ALBUM_ART,
        };

        const result = {
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

        return result;
      })
      .fail(function (error) {
        const errorMessage = error.message || 'Unknown error occurred';
        self.logger.error(`Failed to resolve station info for ${stationCode}: ${errorMessage}`);

        // Log additional context for debugging
        if (error.stack) {
          self.logger.error('Error stack trace:', error.stack);
        }

        self.commandRouter.pushToastMessage('error', self.getRadioI18nString('PLUGIN_NAME'), self.getRadioI18nString('ERROR_STREAMING'));

        throw error; // Re-throw to be caught by the promise chain
      });
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

ControllerPlanetRadio.prototype.authenticate = function () {
  const self = this;

  // Check if we have credentials
  const username = self.config.get('username');
  const password = self.config.get('password');

  if (!username || !password) {
    self.commandRouter.pushToastMessage('error', self.getRadioI18nString('PLUGIN_NAME'), self.getRadioI18nString('ERROR_NO_CREDENTIALS'));
    return libQ.reject(new Error(self.getRadioI18nString('ERROR_NO_CREDENTIALS')));
  }

  self.logger.info('Starting authentication with AuthManager...');

  // Use AuthManager to handle authentication (now returns libQ promise directly)
  return self.authManager
    .authenticate(username, password)
    .then(function (userId) {
      self.logger.info(`AuthManager authentication successful, user ID: ${userId}`);
      return userId;
    })
    .fail(function (error) {
      const errorMessage = error.message || 'Unknown authentication error';
      self.logger.error(`Authentication failed: ${errorMessage}`);

      // Log additional context for debugging
      if (error.stack) {
        self.logger.error('Authentication error stack trace:', error.stack);
      }

      self.commandRouter.pushToastMessage('error', self.getRadioI18nString('PLUGIN_NAME'), self.getRadioI18nString('ERROR_INVALID_CREDENTIALS'));

      throw error; // Re-throw to be caught by the promise chain
    });
};

ControllerPlanetRadio.prototype.getRootContent = function () {
  const self = this;

  self.logger.info('Getting root content - fetching stations...');

  // Use StationManager to get stations (now returns libQ promise directly)
  return self.stationManager
    .getStations()
    .then(function (stations) {
      self.logger.info(`Stations received in getRootContent: ${stations.length} stations`);
      const result = {
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
      self.logger.info('Root content result created successfully');
      return result;
    })
    .fail(function (error) {
      const errorMessage = error.message || 'Unknown error occurred';
      self.logger.error(`Failed to get root content: ${errorMessage}`);

      // Log additional context for debugging
      if (error.stack) {
        self.logger.error('Error stack trace:', error.stack);
      }

      self.commandRouter.pushToastMessage('error', self.getRadioI18nString('PLUGIN_NAME'), self.getRadioI18nString('ERROR_STREAMING'));

      throw error; // Re-throw to be caught by the promise chain
    });
};

ControllerPlanetRadio.prototype.explodeUri = function (uri) {
  const self = this;

  self.logger.info(`explodeUri called with URI: ${uri}`);

  if (uri.startsWith('planetradio/')) {
    const stationCode = uri.split('/')[1];

    self.logger.info(`Extracted station code: ${stationCode}`);

    // Use StationManager to get station info (now returns libQ promise directly)
    return self.stationManager
      .getStationInfo(stationCode)
      .then(function (stationInfo) {
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
        return track;
      })
      .fail(function (error) {
        const errorMessage = error.message || 'Unknown error occurred';
        self.logger.error(`Failed to explode URI ${uri}: ${errorMessage}`);

        // Log additional context for debugging
        if (error.stack) {
          self.logger.error('Error stack trace:', error.stack);
        }

        self.commandRouter.pushToastMessage('error', self.getRadioI18nString('PLUGIN_NAME'), self.getRadioI18nString('ERROR_STREAMING'));

        throw error; // Re-throw to be caught by the promise chain
      });
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

  self.logger.info('ControllerPlanetRadio::clearAddPlayTrack called');
  self.logger.info(`Track object: ${JSON.stringify(track)}`);

  // Stop whatever is currently playing and clean up before starting new playback
  self.logger.info('Stopping current playback and cleaning up before starting new playback...');

  // Clear any existing metadata timer
  if (self.metadataUpdateTimer) {
    try {
      clearTimeout(self.metadataUpdateTimer);
      self.metadataUpdateTimer = null;
    } catch (error) {
      self.logger.warn('Error clearing metadata timer:', error.message);
    }
  }

  // Stop any existing streaming proxy
  if (self.streamingProxy) {
    try {
      self.streamingProxy.stop();
      self.streamingProxy = null;
    } catch (error) {
      self.logger.warn('Error stopping existing streaming proxy:', error.message);
    }
  }

  // Reset metadata timing flag for new playback
  self.isFirstTimeMetadata = true;

  // First authenticate, then get streaming URL with parameters and start proxy
  self.logger.info('Starting clearAddPlayTrack - authenticating first...');
  self
    .authenticate()
    .then(function (userId) {
      self.logger.info(`Authentication successful, proceeding to get station info... User ID: ${userId}`);
      // Extract station code from track.uri if possible (e.g., planetradio/[stationCode])
      let stationCode = DEFAULT_STATION_CODE; // default
      if (track && track.uri && track.uri.startsWith('planetradio/')) {
        stationCode = track.uri.split('/')[1];
      }

      self.logger.info(`Getting station info for station code: ${stationCode}`);

      // Get station info and store it (now returns libQ promise directly)
      return self.stationManager.getStationInfo(stationCode);
    })
    .then(function (stationInfo) {
      self.logger.info(`Station info received: ${JSON.stringify(stationInfo)}`);
      self.currentStationInfo = stationInfo;

      self.logger.info(`Getting streaming URL for station: ${stationInfo.code}`);

      // Get streaming URL (now returns libQ promise directly)
      return self.stationManager.getStreamingURL(stationInfo.code);
    })
    .then(function (streamUrl) {
      self.logger.info(`Streaming URL received: ${streamUrl}`);
      self.logger.info('Creating streaming proxy...');

      // Create the appropriate streaming proxy using the factory method
      self.streamingProxy = StreamingProxyFactory.createProxy(streamUrl, self.logger, self.addAuthParamsToStreamURL.bind(self));

      // Set up metadata callback for the streaming proxy
      self.streamingProxy.setMetadataCallback(function (metadata) {
        self.pushSongState(metadata);
      });

      self.logger.info('Starting proxy server...');
      return self.streamingProxy.startProxyServer(streamUrl, self.currentStationInfo.code);
    })
    .then(function () {
      // Update track URI to use local proxy
      track.uri = self.streamingProxy.getLocalStreamUrl();
      self.logger.info(`Updated track URI to local proxy: ${track.uri}`);

      self.logger.info('Sending MPD stop command...');
      return self.mpdPlugin.sendMpdCommand('stop', []);
    })
    .then(function () {
      self.logger.info('Sending MPD clear command...');
      return self.mpdPlugin.sendMpdCommand('clear', []);
    })
    .then(function () {
      self.logger.info('Sending MPD add command...');
      return self.mpdPlugin.sendMpdCommand(`add "${track.uri}"`, []);
    })
    .then(function () {
      self.logger.info('Sending MPD consume command...');
      return self.mpdPlugin.sendMpdCommand('consume 1', []);
    })
    .then(function () {
      self.logger.info('Sending MPD play command...');
      self.commandRouter.pushToastMessage('info', self.getRadioI18nString('PLUGIN_NAME'), self.getRadioI18nString('WAIT_FOR_RADIO_CHANNEL'));

      return self.mpdPlugin.sendMpdCommand('play', []);
    })
    .then(function () {
      self.logger.info('All MPD commands completed successfully, updating state...');
      self.state.status = 'play';
      self.commandRouter.servicePushState(self.state, self.serviceName);
      self.logger.info('Playback started successfully');

      defer.resolve();
    })
    .fail(function (error) {
      const errorMessage = error.message || 'Unknown error occurred';
      self.logger.error(`Failed to start playback: ${errorMessage}`);

      // Log additional context for debugging
      if (error.stack) {
        self.logger.error('Error stack trace:', error.stack);
      }

      self.commandRouter.pushToastMessage('error', self.getRadioI18nString('PLUGIN_NAME'), self.getRadioI18nString('ERROR_STREAMING'));

      // Only reject if not already resolved
      if (defer.promise._state === 'pending') {
        defer.reject(new Error(self.getRadioI18nString('ERROR_STREAMING')));
      } else {
        self.logger.warn('Promise already resolved, skipping reject');
      }
    });

  return defer.promise;
};

ControllerPlanetRadio.prototype.pushSongState = function (metadata) {
  const self = this;

  // Clear existing timer
  if (self.metadataUpdateTimer) {
    clearTimeout(self.metadataUpdateTimer);
  }

  // Check if this is the first time metadata is being pushed
  if (self.isFirstTimeMetadata) {
    // First time - update immediately, no delay
    self.logger.info('First time metadata - updating immediately');
    self.isFirstTimeMetadata = false; // Set flag to false for subsequent calls

    self
      .pushSongStateImmediate(metadata)
      .then(function () {
        // Success - metadata updated immediately
        self.logger.info('First metadata update completed immediately');
      })
      .fail(function (error) {
        self.logger.warn('Non-critical error in first metadata update:', error.message);
      });
  } else {
    // Subsequent calls - use delay
    const metadataDelay = self.config.get('metadata_delay', DEFAULT_METADATA_DELAY);
    self.logger.info(`Subsequent metadata update - using ${metadataDelay}s delay`);

    self.metadataUpdateTimer = setTimeout(function () {
      self.logger.info('Metadata update timer triggered. Fetching MPD status...');
      self
        .pushSongStateImmediate(metadata)
        .then(function () {
          // Success - metadata updated after delay
        })
        .fail(function (error) {
          self.logger.warn('Non-critical error in pushSongState:', error.message);
          // Continue with basic metadata even if MPD status fails
        });
    }, metadataDelay * 1000);
  }
};

ControllerPlanetRadio.prototype.pushSongStateImmediate = function (metadata) {
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
  self.mpdPlugin
    .sendMpdCommand('status', [])
    .then(function (status) {
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

      // Update Volumio state with metadata (with or without MPD audio info)
      self.updateVolumioState(planetRockState);
      defer.resolve();
    })
    .fail(function (error) {
      self.logger.warn('Failed to get MPD status, continuing with basic metadata:', error.message);
      // Continue with basic metadata even if MPD status fails

      // Update Volumio state with metadata (with or without MPD audio info)
      self.updateVolumioState(planetRockState);
      defer.resolve();
    });

  return defer.promise;
};

ControllerPlanetRadio.prototype.stop = function () {
  const self = this;

  // Stop MPD playback first
  return self.mpdPlugin
    .stop()
    .then(function () {
      return self.mpdPlugin.sendMpdCommand('clear', []);
    })
    .then(function () {
      self.logger.info('MPD playback stopped successfully');
    })
    .then(function () {
      // Always perform cleanup regardless of MPD command success/failure
      self.updateVolumioState({ status: 'stop' });
      self._cleanupResources();
    });
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

  self.logger.info(`Adding auth parameters to stream URL for user ID: ${userId}`);
  self.logger.info(`Stream URL type: ${typeof streamUrl}, value: ${streamUrl}`);

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
    self.logger.info('Auth parameters added successfully');
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

module.exports = ControllerPlanetRadio;

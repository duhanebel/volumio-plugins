'use strict';

const StreamingProxy = require('./StreamingProxy');
const axios = require('axios');

// Constants
const RETRY_DELAY = 1000;
const HTTP_OK = 200;
const HTTP_INTERNAL_SERVER_ERROR = 500;

/**
 * Streaming proxy for direct AAC streams
 */
class DirectStreamingProxy extends StreamingProxy {
  constructor(logger, addAuthParamsCallback) {
    super(logger, addAuthParamsCallback);
  }

  /**
   * Setup EventSource for live metadata
   */
  setupEventSource() {
    const self = this;

    if (!self.aisSessionId) {
      self.logger.error('No AISSessionId available for EventSource connection');
      return;
    }

    const url = 'https://stream-mz.hellorayo.co.uk/metadata?type=json';
    self.logger.info(`Connecting to EventSource URL: ${url}`);

    const options = {
      headers: {
        Cookie: self.aisSessionId,
        Accept: 'text/event-stream',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3.1 Safari/605.1.15',
      },
      rejectUnauthorized: false,
    };

    // Close existing EventSource if any
    if (self.eventSource) {
      self.logger.info('Closing existing EventSource connection');
      self.eventSource.close();
    }

    // Create new EventSource connection
    self.eventSource = new (require('eventsource'))(url, options);

    self.eventSource.onopen = function () {
      self.logger.info('EventSource connection established');
    };

    self.eventSource.onerror = function (error) {
      const timestamp = new Date().toISOString();
      self.logger.error(`[${timestamp}] EventSource error details:`);
      self.logger.error(`[${timestamp}] - Error object:`, JSON.stringify(error, null, 2));
      self.logger.error(`[${timestamp}] - ReadyState:`, self.eventSource.readyState);
      self.logger.error(`[${timestamp}] - URL:`, url);
      self.logger.error(`[${timestamp}] - Headers:`, JSON.stringify(options.headers, null, 2));

      if (self.eventSource.readyState === require('eventsource').CLOSED) {
        self.logger.info(`[${timestamp}] Connection closed, attempting to reconnect in 1 second...`);
        setTimeout(() => self.setupEventSource(), RETRY_DELAY);
      }
    };

    self.eventSource.onmessage = function (event) {
      try {
        self.logger.info(`Received raw EventSource message: ${event.data}`);

        const messageData = JSON.parse(event.data);
        self.logger.info(`Parsed EventSource message: ${JSON.stringify(messageData, null, 2)}`);

        if (messageData['metadata-list'] && messageData['metadata-list'].length > 0) {
          const [{ metadata }] = messageData['metadata-list'];
          self.logger.info(`Extracted metadata string: ${metadata}`);

          const metadataObj = self.parseMetadataString(metadata);
          self.logger.info(`Parsed metadata object: ${JSON.stringify(metadataObj, null, 2)}`);

          if (metadataObj.url) {
            if (metadataObj.url.endsWith('/eventdata/-1')) {
              self.logger.info('Received -1 event data URL, fetching show information');
              self.fetchShowData(self.currentStationCode).then(metadata => self.updateMetadata(metadata));
              return;
            }

            // Fetch track data from the API (like the old working version)
            axios
              .get(metadataObj.url)
              .then(response => {
                self.logger.info(`Track data response: ${JSON.stringify(response.data, null, 2)}`);

                if (response.data) {
                  const trackData = response.data;
                  const metadata = self.createMetadataObject(trackData.eventSongTitle, trackData.eventSongArtist, '', trackData.eventImageUrl);
                  self.updateMetadata(metadata);
                }
              })
              .catch(error => {
                self.logger.error(`Failed to fetch track data: ${error.message}`);
                const metadata = self.createMetadataObject('Unknown Track', 'Planet Rock', '', '');
                self.updateMetadata(metadata);
              });
          }
        }
      } catch (error) {
        self.logger.error(`Failed to parse EventSource message: ${error.message}`);
        self.logger.error(`Raw message data: ${event.data}`);
      }
    };
  }

  /**
   * Parse metadata string
   * @param {string} metadata - The metadata string
   * @returns {Object} - Parsed metadata object
   */
  parseMetadataString(metadata) {
    const metadataObj = {};
    metadata.split(',').forEach(pair => {
      const [key, value] = pair.split('=');
      if (key && value) {
        metadataObj[key] = value.replace(/^"|"$/g, '');
      }
    });
    return metadataObj;
  }

  /**
   * Create metadata object (like the old working version)
   * @param {string} title - Track title
   * @param {string} artist - Track artist
   * @param {string} album - Track album
   * @param {string} albumart - Album art URL
   * @param {string} uri - Stream URI (optional)
   * @returns {Object} - Metadata object
   */
  createMetadataObject(title, artist, album, albumart, uri) {
    return {
      title: title || 'Unknown Track',
      artist: artist || 'Planet Rock',
      album: album || '',
      albumart: albumart || '/albumart?sourceicon=music_service/planetrock_multi_radio/assets/planetrock_multi_radio.webp',
      uri: uri || `http://localhost:${this.proxyPort || '3000'}/stream`,
    };
  }

  /**
   * Update metadata with delay logic (like the old working version)
   * @param {Object} metadata - The metadata object to update
   */
  updateMetadata(metadata) {
    const self = this;

    // Use the common metadata update method from the base class
    if (self.onMetadataUpdate) {
      self.onMetadataUpdate(metadata);
    }
  }

  /**
   * Fetch show data for station (like the old working version)
   * @param {string} stationCode - The station code
   * @returns {Promise<Object>} - Promise resolving to show metadata
   */
  async fetchShowData(stationCode) {
    const self = this;
    const url = `https://listenapi.planetradio.co.uk/api9.2/stations_nowplaying/GB?StationCode%5B%5D=${stationCode}&premium=1`;

    try {
      const response = await axios.get(url);
      self.logger.info(`Show data response: ${JSON.stringify(response.data, null, 2)}`);

      if (response.data && response.data[0] && response.data[0].stationOnAir) {
        const showData = response.data[0].stationOnAir;
        return self.createMetadataObject(showData.episodeTitle, 'Planet Rock', showData.episodeDescription, showData.episodeImageUrl);
      }
      throw new Error('No show data available');
    } catch (error) {
      self.logger.error(`Failed to fetch show data: ${error.message}`);
      return self.createMetadataObject('Non stop music', 'Planet Rock', '', '');
    }
  }

  /**
   * Handle direct AAC streams
   * @param {URL} streamUrl - The stream URL object
   * @param {Object} res - HTTP response object
   */
  async handleStream(streamUrl, res) {
    const self = this;

    try {
      self.logger.info(`Starting direct stream handling for URL: ${streamUrl.toString()}`);

      const authenticatedStreamUrl = self.addAuthParamsCallback(streamUrl);
      self.logger.info(`Authenticated stream URL: ${authenticatedStreamUrl.toString()}`);

      const response = await axios({
        method: 'get',
        url: authenticatedStreamUrl.toString(),
        responseType: 'stream',
        headers: {
          Accept: '*/*',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3.1 Safari/605.1.15',
        },
        httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false }),
      });

      self.logger.info(`Stream response received, status: ${response.status}`);

      // Get cookies from response
      const cookies = response.headers['set-cookie'];
      if (cookies) {
        for (const cookie of cookies) {
          if (cookie.startsWith('AISSessionId=')) {
            self.aisSessionId = cookie.split(';')[0];
            self.logger.info(`Captured AISSessionId: ${self.aisSessionId}`);
            // Start metadata connection
            self.setupEventSource();
            break;
          }
        }
      }

      // Set appropriate headers
      res.writeHead(HTTP_OK, {
        'Content-Type': 'audio/aac',
        'Transfer-Encoding': 'chunked',
      });

      self.logger.info('Stream headers set, starting to pipe data...');

      // Pipe the stream
      response.data.pipe(res);

      // Handle stream end
      response.data.on('end', () => {
        self.logger.info('Direct stream ended, restarting...');
        res.end();
      });

      // Handle stream error
      response.data.on('error', error => {
        self.logger.error(`Direct stream error: ${error}`);
        res.end();
      });
    } catch (error) {
      self.logger.error(`Direct stream request error: ${error}`);
      res.writeHead(HTTP_INTERNAL_SERVER_ERROR);
      res.end();
    }
  }
}

module.exports = DirectStreamingProxy;

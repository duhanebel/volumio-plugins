'use strict';

const StreamingProxy = require('./StreamingProxy');
const axios = require('axios');

// Constants
const RETRY_DELAY = 1000;
const HTTP_OK = 200;

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

    self.eventSource.onmessage = async function (event) {
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
            // Use the common metadata fetching method
            await self.fetchAndUpdateMetadata(metadataObj.url, 'EventSource');
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
        ...self.getCommonRequestOptions(),
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
        self.logger.error(`Stream data error: ${error.message}`);
        self.handleStreamError(error, 'Direct stream', res);
      });
    } catch (error) {
      self.logger.error(`Failed to handle direct stream: ${error.message}`);
      if (error.stack) {
        self.logger.error('Error stack trace:', error.stack);
      }
      self.handleStreamError(error, 'Direct stream request', res);
    }
  }
}

module.exports = DirectStreamingProxy;

'use strict';

const DirectStreamingProxy = require('./DirectStreamingProxy');
const M3U8StreamingProxy = require('./M3U8StreamingProxy');

/**
 * Factory for creating streaming proxies
 */
class StreamingProxyFactory {
  /**
   * Static factory method to detect stream type and create appropriate proxy
   * @param {URL} streamUrl - The stream URL to analyze
   * @param {Object} logger - Logger instance
   * @param {Function} addAuthParamsCallback - Callback to add auth parameters
   * @returns {BaseStreamingProxy} - The appropriate streaming proxy instance
   */
  static createProxy(streamUrl, logger, addAuthParamsCallback) {
    // Create appropriate proxy based on stream type
    if (streamUrl.pathname.includes('.m3u8')) {
      logger.info('Creating M3U8 streaming proxy for HLS stream');
      return new M3U8StreamingProxy(logger, addAuthParamsCallback);
    } else {
      logger.info('Creating direct streaming proxy for AAC stream');
      return new DirectStreamingProxy(logger, addAuthParamsCallback);
    }
  }
}

module.exports = StreamingProxyFactory;

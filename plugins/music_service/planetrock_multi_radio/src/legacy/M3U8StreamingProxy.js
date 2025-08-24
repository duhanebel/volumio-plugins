'use strict';

const StreamingProxy = require('./StreamingProxy');
const axios = require('axios');

// Constants
const RETRY_DELAY = 1000; // 1 second retry delay (same as old working version)
const HTTP_OK = 200;

/**
 * Streaming proxy for HLS/M3U8 streams
 */
class M3U8StreamingProxy extends StreamingProxy {
  constructor(logger, addAuthParamsCallback) {
    super(logger, addAuthParamsCallback);

    // HLS streaming state
    this.isHlsStreaming = false;
    this.hlsRefreshTimer = null;
    this.currentHlsSegments = null;
    this.lastHlsMetadataUrl = null;
    this.currentMediaPlaylistUrl = null;
    this.currentHlsResponse = null;
    this.lastPlayedProgressiveCounter = 0; // Track the highest progressive counter we've played
  }

  async handleStream(playlistUrl, res) {
    const self = this;

    // Set appropriate headers for HLS stream with buffering
    res.writeHead(HTTP_OK, {
      'Content-Type': 'audio/aac',
      'Transfer-Encoding': 'chunked',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    try {
      const authenticatedStreamUrl = self.addAuthParamsCallback(playlistUrl);
      // First, try to resolve master playlist to get the media playlist URL

      self.currentMediaPlaylistUrl = await self.resolveMasterPlaylist(authenticatedStreamUrl);

      // Fetch and parse the media playlist
      const segments = await self.fetchM3u8Playlist(self.currentMediaPlaylistUrl);

      if (segments.length === 0) {
        throw new Error('No segments found in M3U8 playlist');
      }

      self.logger.info(`Starting HLS segment streaming with ${segments.length} segments for: ${playlistUrl.toString()}`);

      // Create a mutable segments array for refresh functionality
      const segmentsArray = [...segments];

      self.streamHlsSegments(segmentsArray, res);
    } catch (error) {
      self.handleStreamError(error, 'HLS stream handling', res);
    }
  }

  /**
   * Resolve master playlist to get the media playlist URL
   * @param {URL} playlistUrl - The master playlist URL
   * @returns {Promise<URL|null>} - The media playlist URL or null if not a master playlist
   */
  async resolveMasterPlaylist(playlistUrl) {
    const self = this;

    try {
      const response = await axios.get(playlistUrl.toString(), {
        headers: {
          Accept: 'application/vnd.apple.mpegurl, application/x-mpegURL, text/plain, */*',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3.1 Safari/605.1.15',
        },
      });

      self.logger.info(`Fetched playlist from: ${playlistUrl.toString()}`);

      // Check if this is a master playlist (contains stream variants)
      if (response.data.includes('#EXT-X-STREAM-INF:')) {
        const mediaPlaylistUrl = self.parseMasterPlaylist(response.data);

        if (mediaPlaylistUrl) {
          self.logger.info(`Found media playlist URL: ${mediaPlaylistUrl.toString()}`);
          return mediaPlaylistUrl;
        }
      }

      // Not a master playlist, return null
      return null;
    } catch (error) {
      self.logger.error(`Failed to resolve master playlist: ${error.message}`);
      throw error;
    }
  }

  /**
   * Fetch and parse M3U8 media playlist
   * @param {URL} playlistUrl - The media playlist URL object
   * @returns {Promise<Array>} - Promise resolving to array of segments
   */
  async fetchM3u8Playlist(playlistUrl) {
    const self = this;

    try {
      const response = await axios.get(playlistUrl.toString(), {
        headers: {
          Accept: 'application/vnd.apple.mpegurl, application/x-mpegURL, text/plain, */*',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3.1 Safari/605.1.15',
        },
      });

      const segments = self.parseM3u8Playlist(response.data);

      return segments;
    } catch (error) {
      self.logger.error(`Failed to fetch M3U8 playlist: ${error.message}`);
      throw error;
    }
  }

  /**
   * Parse master playlist to extract the media playlist URL
   * @param {string} playlistContent - The playlist content
   * @returns {URL|null} - The media playlist URL object or null if not found
   */
  parseMasterPlaylist(playlistContent) {
    const lines = playlistContent.split('\n');

    for (const line of lines) {
      const trimmedLine = line.trim();

      // Skip empty lines and comment lines
      if (!trimmedLine || trimmedLine.startsWith('#')) {
        continue;
      }

      // Return the first URL that contains 'playlist.m3u8' in the path
      if (trimmedLine.includes('playlist.m3u8')) {
        return new URL(trimmedLine);
      }
    }

    return null;
  }

  /**
   * Parse M3U8 media playlist to extract segments and metadata URLs
   * @param {string} playlistContent - The playlist content
   * @returns {Array<Object>} - Array of segment objects
   */
  parseM3u8Playlist(playlistContent) {
    const segments = [];
    const lines = playlistContent.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      // Parse segment information with metadata URLs
      if (line.startsWith('#EXTINF:')) {
        // Next line should be the segment URL
        if (i + 1 < lines.length && !lines[i + 1].startsWith('#')) {
          const duration = parseFloat(line.split(':')[1].split(',')[0]);
          const segmentUrl = lines[i + 1].trim();

          // Extract metadata URL from the title property
          const metadataUrl = this.extractMetadataUrlFromExtinf(line);

          segments.push({
            duration,
            segmentUrl,
            metadataUrl,
          });
        }
      }
    }

    return segments;
  }

  /**
   * Extract metadata URL from #EXTINF line
   * @param {string} extinfLine - The #EXTINF line
   * @returns {string|null} - Metadata URL or null if not found
   */
  extractMetadataUrlFromExtinf(extinfLine) {
    // Parse the url property which contains the metadata URL
    const urlMatch = extinfLine.match(/url="([^"]+)"/);
    if (urlMatch && urlMatch[1]) {
      return urlMatch[1];
    }

    // Fallback to title property if title is not found
    const titleMatch = extinfLine.match(/title="([^"]+)"/);
    if (titleMatch && titleMatch[1]) {
      return titleMatch[1];
    }

    return null;
  }

  /**
   * Extract progressive counter from segment URL
   * @param {string} segmentUrl - The segment URL
   * @returns {number} - The progressive counter value, or 0 if not found
   */
  _extractProgressiveCounter(segmentUrl) {
    // Extract progressive counter from URL format:
    // https://chunks-aphls.hellorayo.co.uk/pr_webcast1_master.aac/[random id]-[progressive counter]-[other id].aac
    const match = segmentUrl.match(/\/([^-]+)-(\d+)-([^-]+)\.aac$/);
    if (match) {
      const counter = parseInt(match[2], 10);
      return isNaN(counter) ? 0 : counter;
    }
    return 0;
  }

  /**
   * Stream HLS segments
   * @param {Array} segments - Array of segment objects
   * @param {Object} res - HTTP response object
   */
  streamHlsSegments(segments, res) {
    const self = this;

    self.isHlsStreaming = true;
    
    // Store state for the streaming session
    self.currentHlsSegments = [...segments]; // Create a copy to avoid external modifications
    self.currentHlsResponse = res;
    self.lastHlsMetadataUrl = null;

    // Start streaming
    self._streamNextSegment();
  }

  /**
   * Private method to stream the next HLS segment
   * @private
   */
  async _streamNextSegment() {
    const self = this;
    
    if (!self.isHlsStreaming) {
      self.logger.info('HLS streaming stopped');
      if (self.currentHlsResponse) {
        self.currentHlsResponse.end();
      }
      return;
    }

    // Check if we have a valid response object
    if (!self.currentHlsResponse) {
      self.logger.error('No valid response object available for streaming');
      return;
    }

    // If we've reached the end of segments, refresh the playlist
    if (self.currentHlsSegments.length === 0) {
      self.logger.info('No more segments, refreshing playlist...');
      const currentPlaylistUrl = self.currentMediaPlaylistUrl;
        
      try {
        const newSegments = await self.fetchNewHlsSegments(currentPlaylistUrl, self.currentHlsSegments);
        if (newSegments.length > 0) {
          self.logger.info(`Adding ${newSegments.length} new segments to playlist`);
          self.currentHlsSegments.push(...newSegments);
        }
      } catch (error) {
        self.logger.error(`Failed to refresh playlist: ${error.message}`);
      }
        
      // If we still have no segments after refresh, we might want to stop or retry
      if (self.currentHlsSegments.length === 0) {
        self.logger.warn('No segments available even after refresh, stopping streaming');
        return;
      }
      
      // Continue with normal flow - don't call recursively, just let it continue
    }

    // Take the next segment from the front of the queue and remove it
    const segment = self.currentHlsSegments.shift();
    
    // Update the last played progressive counter
    self.lastPlayedProgressiveCounter = self._extractProgressiveCounter(segment.segmentUrl);
    
    self.logger.info(`Streaming HLS segment (${self.currentHlsSegments.length} remaining, duration: ${segment.duration}s, progressive counter: ${self.lastPlayedProgressiveCounter}): ${segment.segmentUrl}`);

    // Fetch metadata for this segment only if it's different from the last one
    if (segment.metadataUrl && segment.metadataUrl !== self.lastHlsMetadataUrl) {
      self.logger.info(`Fetching new metadata from: ${segment.metadataUrl}`);
      self.lastHlsMetadataUrl = segment.metadataUrl;

      // Use the metadata fetcher to fetch and update metadata
      self.metadataFetcher.fetchAndUpdateMetadata(segment.metadataUrl, self.stationCode, 'segment').catch(error => {
        self.logger.error(`Failed to fetch segment metadata: ${error.message}`);
      });
    } else if (segment.metadataUrl === self.lastHlsMetadataUrl) {
      self.logger.info('Skipping metadata fetch - same URL as previous segment');
    }

    try {
      const response = await axios({
        method: 'get',
        url: segment.segmentUrl,
        responseType: 'stream',
        ...self.getCommonRequestOptions(),
      });

      // Pipe the segment data
      response.data.pipe(self.currentHlsResponse, { end: false });

      // Schedule the next segment based on the segment's actual duration
      const segmentDurationMs = (segment.duration || 10) * 1000; // Default to 10 seconds if duration is missing
      self.logger.info(`Segment will play for ${segment.duration || 10} seconds, scheduling next segment`);
      
      setTimeout(() => {
        self.logger.info('Segment duration completed, moving to next segment');
        self._streamNextSegment();
      }, segmentDurationMs);

      // Handle segment download error (but don't move to next segment immediately)
      response.data.on('error', error => {
        self.logger.error(`HLS segment download error: ${error.message}`);
        // Don't immediately move to next segment - let the timer handle it
        // unless it's a critical error that prevents streaming
      });
    } catch (error) {
      self.logger.error(`Failed to stream HLS segment: ${error.message}`);
      // Continue with next segment
      setTimeout(() => self._streamNextSegment(), RETRY_DELAY);
    }
  }

  /**
   * Refresh HLS playlist
   * @param {URL} playlistUrl - The playlist URL object
   */
  async fetchNewHlsSegments(playlistUrl) {
    const self = this;

    // Use the callback to add authentication parameters (callback handles all auth logic)
    const authenticatedPlaylistUrl = self.addAuthParamsCallback(playlistUrl);
    self.logger.info(`Refreshing HLS playlist: ${authenticatedPlaylistUrl}`);

    try {
      const newSegments = await self.fetchM3u8Playlist(playlistUrl);

      if (newSegments.length === 0) {
        throw new Error('No segments found in refreshed M3U8 playlist');
      }

      // Filter out segments that have already been played based on progressive counter
      const segmentsToAdd = newSegments.filter(segment => {
        const progressiveCounter = self._extractProgressiveCounter(segment.segmentUrl);
        return progressiveCounter > self.lastPlayedProgressiveCounter;
      });

      self.logger.info(`Found ${segmentsToAdd.length} new segments to add (filtered out ${newSegments.length - segmentsToAdd.length} old segments)`);

      return segmentsToAdd;

    } catch (error) {
      self.logger.error(`Failed to refresh HLS playlist: ${error.message}`);
    }

    return [];
  }

  /**
   * Stop the proxy server and clean up resources
   */
  stop() {
    const self = this;
    super.stop();
    
    self.logger.info('Stopping M3U8 streaming proxy and cleaning up HLS resources');

    // Stop HLS streaming
    self.isHlsStreaming = false;

    // Clear HLS refresh timer
    if (self.hlsRefreshTimer) {
      clearTimeout(self.hlsRefreshTimer);
      self.hlsRefreshTimer = null;
    }

    // Reset HLS-specific state
    self.currentHlsSegments = null;
    self.lastHlsMetadataUrl = null;
    self.currentMediaPlaylistUrl = null;
    self.currentHlsResponse = null;
    self.lastPlayedProgressiveCounter = 0;

    self.logger.info('M3U8 streaming proxy cleanup completed');
  }
}

module.exports = M3U8StreamingProxy;

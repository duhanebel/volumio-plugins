'use strict';

const StreamingProxy = require('./StreamingProxy');
const axios = require('axios');

// Constants
const RETRY_DELAY = 1000; // 1 second retry delay (same as old working version)
const HTTP_OK = 200;
const SEGMENT_TRANSITION_DELAY = 50; // Delay between segments for smooth transition (ms)

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
  }

  async handleStream(playlistUrl, res) {
    const self = this;

    self.logger.info(`Starting HLS stream handling for: ${playlistUrl.toString()}`);

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

      self.logger.info(`Starting HLS segment streaming with ${segments.length} segments`);

      // Create a mutable segments array for refresh functionality
      const segmentsArray = [...segments];

      // Start streaming segments
      self.isHlsStreaming = true;
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
        self.logger.info('Detected master playlist, extracting media playlist URL');
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

      self.logger.info(`Fetched media playlist from: ${playlistUrl.toString()}`);

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
   * Stream HLS segments
   * @param {Array} segments - Array of segment objects
   * @param {Object} res - HTTP response object
   */
  streamHlsSegments(segments, res) {
    const self = this;
    
    // Store state for the streaming session
    self.currentHlsSegments = segments;
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

    // If we've reached the end of segments, refresh the playlist
    if (self.currentHlsSegments.length === 0) {
      self.logger.info('No more segments, refreshing playlist...');
      const currentPlaylistUrl = self.currentMediaPlaylistUrl;
      self.refreshHlsPlaylist(currentPlaylistUrl, self.currentHlsSegments, self.currentHlsResponse, newSegmentsAdded => {
        if (newSegmentsAdded > 0) {
          self.logger.info(`Added ${newSegmentsAdded} new segments to playlist`);
        }
        // Always continue streaming after refresh
        self._streamNextSegment();
      });
      return;
    }

    // Take the next segment from the front of the queue and remove it
    const segment = self.currentHlsSegments.shift();
    self.logger.info(`Streaming HLS segment (${self.currentHlsSegments.length} remaining): ${segment.segmentUrl}`);

    // Fetch metadata for this segment only if it's different from the last one
    if (segment.metadataUrl && segment.metadataUrl !== self.lastHlsMetadataUrl) {
      self.logger.info(`Fetching new metadata from: ${segment.metadataUrl}`);
      self.lastHlsMetadataUrl = segment.metadataUrl;

      // Use the superclass method to fetch and update metadata
      self.fetchAndUpdateMetadata(segment.metadataUrl, 'segment').catch(error => {
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

      // Handle segment end - this is more reliable than setTimeout
      response.data.on('end', () => {
        self.logger.info('HLS segment completed');
        // Move to next segment with minimal delay to reduce gaps
        setTimeout(() => {
          self._streamNextSegment();
        }, SEGMENT_TRANSITION_DELAY);
      });

      // Handle segment error
      response.data.on('error', error => {
        self.logger.error(`HLS segment error: ${error.message}`);
        // Continue with next segment
        self._streamNextSegment();
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
   * @param {Array} currentSegments - Current segments array
   * @param {Object} res - HTTP response object
   * @param {Function} continueCallback - Callback to continue streaming
   */
  async refreshHlsPlaylist(playlistUrl, currentSegments, res, continueCallback) {
    const self = this;

    // Use the callback to add authentication parameters (callback handles all auth logic)
    const authenticatedPlaylistUrl = self.addAuthParamsCallback(playlistUrl);
    self.logger.info(`Refreshing HLS playlist: ${authenticatedPlaylistUrl}`);

    try {
      const newSegments = await self.fetchM3u8Playlist(playlistUrl);

      if (newSegments.length === 0) {
        throw new Error('No segments found in refreshed M3U8 playlist');
      }

      self.logger.info(`Refreshed playlist has ${newSegments.length} segments`);

      // Simple approach: just filter out existing segments by URL (like the old working version)
      const currentSegmentUrls = new Set(currentSegments.map(seg => seg.segmentUrl));
      const segmentsToAdd = newSegments.filter(segment => !currentSegmentUrls.has(segment.segmentUrl));

      self.logger.info(`Found ${segmentsToAdd.length} new segments to add`);

      // Add the new segments to the current playlist
      segmentsToAdd.forEach(segment => currentSegments.push(segment));

      // Call the callback with the number of new segments added
      continueCallback(segmentsToAdd.length);
    } catch (error) {
      self.logger.error(`Failed to refresh HLS playlist: ${error.message}`);
      // Retry after a short delay
      setTimeout(() => {
        self.refreshHlsPlaylist(playlistUrl, currentSegments, res, continueCallback);
      }, RETRY_DELAY);
    }
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

    self.logger.info('M3U8 streaming proxy cleanup completed');
  }
}

module.exports = M3U8StreamingProxy;

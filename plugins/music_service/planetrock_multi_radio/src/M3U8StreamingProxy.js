'use strict';

const StreamingProxy = require('./StreamingProxy');
const axios = require('axios');

// Constants
const RETRY_DELAY = 1000;
const HTTP_OK = 200;
const SEGMENT_DURATION_TOLERANCE = 0.5; // Tolerance for segment duration matching (seconds)
const SEGMENT_TRANSITION_DELAY = 50; // Delay between segments for smooth transition (ms)

/**
 * Streaming proxy for HLS/M3U8 streams
 */
class M3U8StreamingProxy extends StreamingProxy {
  constructor(logger, addAuthParamsCallback) {
    super(logger, addAuthParamsCallback);

    // HLS streaming state
    this.hlsCleanupFunction = null;
    this.hlsRefreshTimer = null;
    this.isHlsStreaming = false;
    this.currentHlsSegments = null;
    this.currentHlsSegmentIndex = null;
    this.lastHlsMetadataUrl = null;
    this.currentMediaPlaylistUrl = null;
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
      const mediaPlaylistUrl = await self.resolveMasterPlaylist(authenticatedStreamUrl);

      // Use the resolved media playlist URL or the original URL if not a master playlist
      const finalPlaylistUrl = mediaPlaylistUrl || authenticatedStreamUrl;

      // Store the media playlist URL for refresh operations
      self.currentMediaPlaylistUrl = finalPlaylistUrl;

      // Fetch and parse the media playlist
      const autheticatedFilanPlaylistUrl = self.addAuthParamsCallback(finalPlaylistUrl);
      const segments = await self.fetchM3u8Playlist(autheticatedFilanPlaylistUrl);

      if (segments.length === 0) {
        throw new Error('No segments found in M3U8 playlist');
      }

      self.logger.info(`Starting HLS segment streaming with ${segments.length} segments`);

      // Create a mutable segments array for refresh functionality
      const segmentsArray = [...segments];

      // Start streaming segments
      self.hlsCleanupFunction = self.streamHlsSegments(segmentsArray, res);
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

      // Extract metadata from the first segment if available
      if (segments.length > 0 && segments[0].metadataUrl) {
        self.logger.info(`Fetching metadata from first segment: ${segments[0].metadataUrl}`);
        await self.fetchAndUpdateMetadata(segments[0].metadataUrl, 'first segment');
      }

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
    // Parse the title property which contains the metadata URL
    const titleMatch = extinfLine.match(/title="([^"]+)"/);
    if (titleMatch && titleMatch[1]) {
      return titleMatch[1];
    }

    // Fallback to url property if title is not found
    const urlMatch = extinfLine.match(/url="([^"]+)"/);
    if (urlMatch && urlMatch[1]) {
      return urlMatch[1];
    }

    return null;
  }

  /**
   * Stream HLS segments
   * @param {Array} segments - Array of segment objects
   * @param {Object} res - HTTP response object
   * @returns {Function} - Cleanup function
   */
  streamHlsSegments(segments, res) {
    const self = this;
    let currentIndex = 0;
    let isStreaming = true;

    const streamNextSegment = async () => {
      if (!isStreaming) {
        self.logger.info('HLS streaming stopped');
        res.end();
        return;
      }

      // If we've reached the end of segments, refresh the playlist
      if (currentIndex >= segments.length) {
        self.logger.info('Reached end of segments, refreshing playlist...');
        self.refreshHlsPlaylist(self.currentMediaPlaylistUrl, segments, res, newSegmentsAdded => {
          if (newSegmentsAdded > 0) {
            self.logger.info(`Added ${newSegmentsAdded} new segments to playlist`);
          }
          // Always continue streaming after refresh
          streamNextSegment();
        });
        return;
      }

      const segment = segments[currentIndex];
      self.logger.info(`Streaming HLS segment ${currentIndex + 1}/${segments.length}: ${segment.segmentUrl}`);

      // Check for metadata updates from this segment
      if (segment.metadataUrl && currentIndex === 0) {
        // Only fetch metadata from the first segment to avoid spam
        await self.fetchAndUpdateMetadata(segment.metadataUrl, 'segment');
      }

      // Use the callback to add authentication parameters
      const authenticatedSegmentUrl = self.addAuthParamsCallback(new URL(segment.segmentUrl));

      try {
        const response = await axios({
          method: 'get',
          url: authenticatedSegmentUrl,
          responseType: 'stream',
          ...self.getCommonRequestOptions(),
        });

        // Pipe the segment data
        response.data.pipe(res, { end: false });

        // Handle segment end - this is more reliable than setTimeout
        response.data.on('end', () => {
          self.logger.info(`HLS segment ${currentIndex + 1} completed`);
          // Move to next segment with minimal delay to reduce gaps
          setTimeout(() => {
            currentIndex++;
            streamNextSegment();
          }, SEGMENT_TRANSITION_DELAY);
        });

        // Handle segment error
        response.data.on('error', error => {
          self.logger.error(`HLS segment error: ${error.message}`);
          // Continue with next segment
          currentIndex++;
          streamNextSegment();
        });
      } catch (error) {
        self.logger.error(`Failed to stream HLS segment: ${error.message}`);
        // Continue with next segment
        currentIndex++;
        setTimeout(streamNextSegment, RETRY_DELAY);
      }
    };

    // Start streaming
    streamNextSegment();

    // Return cleanup function
    return () => {
      isStreaming = false;
    };
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

      // Check for metadata updates in the refreshed playlist
      // Note: We don't update metadata here as it might cause flickering
      // Metadata updates are handled when the playlist is initially fetched

      // For live streaming, we need to handle overlapping segments
      // The server might return some of the same segments plus new ones

      // Find the last segment we currently have
      const lastCurrentSegment = currentSegments[currentSegments.length - 1];
      let startIndex = 0;

      if (lastCurrentSegment) {
        // Find where the new playlist starts relative to our current position
        // Try to match by URL first, then by duration if URL matching fails
        const lastSegmentIndex = newSegments.findIndex(seg => seg.segmentUrl === lastCurrentSegment.segmentUrl);
        if (lastSegmentIndex >= 0) {
          // Start adding from the segment after the last one we have
          startIndex = lastSegmentIndex + 1;
        } else {
          // URL matching failed, try to find a segment with similar duration
          // This handles cases where the server returns the same content with different URLs
          const lastSegmentDuration = lastCurrentSegment.duration;
          const similarSegmentIndex = newSegments.findIndex(seg => Math.abs(seg.duration - lastSegmentDuration) < SEGMENT_DURATION_TOLERANCE);
          if (similarSegmentIndex >= 0) {
            startIndex = similarSegmentIndex + 1;
            self.logger.info(`Found similar segment by duration at index ${similarSegmentIndex}`);
          } else {
            // If no matching found, assume we need to refresh the entire playlist
            // This can happen when the server rotates segments
            startIndex = 0;
            self.logger.info('No matching segments found, refreshing entire playlist');
          }
        }
      }

      // Add all segments from the start index onwards
      const segmentsToAdd = newSegments.slice(startIndex);

      self.logger.info(`Found ${segmentsToAdd.length} new segments to add (starting from index ${startIndex})`);

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

    // Clear HLS-specific cleanup function
    if (self.hlsCleanupFunction) {
      self.hlsCleanupFunction();
      self.hlsCleanupFunction = null;
    }

    // Clear HLS refresh timer
    if (self.hlsRefreshTimer) {
      clearTimeout(self.hlsRefreshTimer);
      self.hlsRefreshTimer = null;
    }

    // Reset HLS state
    self.isHlsStreaming = false;
    self.currentHlsSegments = null;
    self.currentHlsSegmentIndex = null;
    self.lastHlsMetadataUrl = null;
    self.currentMediaPlaylistUrl = null;

    // Call parent stop method
    super.stop();
  }
}

module.exports = M3U8StreamingProxy;

'use strict';

const StreamingProxy = require('./StreamingProxy');
const axios = require('axios');
const { StatusCodes } = require('http-status-codes');

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
  }

  async handleStream(playlistUrl, res) {
    const self = this;

    self.logger.info(`Starting HLS stream handling for: ${playlistUrl.toString()}`);

    // Set appropriate headers for HLS stream with buffering
    res.writeHead(StatusCodes.OK, {
      'Content-Type': 'audio/aac',
      'Transfer-Encoding': 'chunked',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    try {
      // First, try to resolve master playlist to get the media playlist URL
      const mediaPlaylistUrl = await self.resolveMasterPlaylist(playlistUrl);

      // Use the resolved media playlist URL or the original URL if not a master playlist
      const finalPlaylistUrl = mediaPlaylistUrl || playlistUrl;

      // Fetch and parse the media playlist
      const segments = await self.fetchM3u8Playlist(finalPlaylistUrl);

      if (segments.length === 0) {
        throw new Error('No segments found in M3U8 playlist');
      }

      self.logger.info(`Starting HLS segment streaming with ${segments.length} segments`);

      // Create a mutable segments array for refresh functionality
      const segmentsArray = [...segments];

      // Start streaming segments
      self.hlsCleanupFunction = self.streamHlsSegments(segmentsArray, res);
    } catch (error) {
      self.logger.error(`Failed to handle HLS stream: ${error.message}`);
      res.writeHead(StatusCodes.INTERNAL_SERVER_ERROR);
      res.end();
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
        try {
          const metadata = await self.fetchMetadataFromUrl(segments[0].metadataUrl);
          if (metadata) {
            self.logger.info(`Extracted metadata from M3U8 playlist: ${JSON.stringify(metadata, null, 2)}`);
            self.updateMetadata(metadata);
          }
        } catch (error) {
          self.logger.error(`Failed to fetch metadata from first segment: ${error.message}`);
        }
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

  async fetchMetadataFromUrl(metadataUrl) {
    const self = this;

    // Skip the -1 event data URL (show information)
    if (metadataUrl && metadataUrl.endsWith('/eventdata/-1')) {
      self.logger.info('Skipping -1 event data URL, fetching show information');
      return await self.fetchShowData(self.currentStationCode);
    }

    if (!metadataUrl) {
      return null;
    }

    try {
      const response = await axios.get(metadataUrl);
      self.logger.info(`Fetched metadata from: ${metadataUrl}`);

      if (response.data) {
        const trackData = response.data;
        return self.createMetadataObject(trackData.eventSongTitle, trackData.eventSongArtist, '', trackData.eventImageUrl);
      }
      return null;
    } catch (error) {
      self.logger.error(`Failed to fetch metadata from URL: ${error.message}`);
      // Fallback to show data
      return await self.fetchShowData(self.currentStationCode);
    }
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
      if (!isStreaming || currentIndex >= segments.length) {
        return;
      }

      const segment = segments[currentIndex];
      self.logger.info(`Streaming segment ${currentIndex + 1} of ${segments.length}: ${segment.segmentUrl}`);

      // Check for metadata updates from this segment
      if (segment.metadataUrl && currentIndex === 0) {
        // Only fetch metadata from the first segment to avoid spam
        try {
          const metadata = await self.fetchMetadataFromUrl(segment.metadataUrl);
          if (metadata) {
            self.logger.info(`Updated metadata from segment: ${JSON.stringify(metadata, null, 2)}`);
            self.updateMetadata(metadata);
          }
        } catch (error) {
          self.logger.error(`Failed to fetch metadata from segment: ${error.message}`);
        }
      }

      // Use the callback to add authentication parameters
      const authenticatedSegmentUrl = self.addAuthParamsCallback(new URL(segment.segmentUrl));

      try {
        const response = await axios({
          method: 'get',
          url: authenticatedSegmentUrl,
          responseType: 'stream',
          headers: {
            Accept: '*/*',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3.1 Safari/605.1.15',
          },
          httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false }),
        });

        // M3U8 streams don't use EventSource for metadata
        // Metadata comes from the playlist itself

        // Pipe the segment data
        response.data.pipe(res, { end: false });

        // Handle segment end
        response.data.on('end', () => {
          currentIndex++;

          // Check if we need to refresh the playlist
          if (currentIndex >= segments.length) {
            self.logger.info('Reached end of playlist, refreshing...');
            self.refreshHlsPlaylist(self.currentStreamUrl, segments, res, newSegmentsCount => {
              if (newSegmentsCount > 0) {
                self.logger.info(`Added ${newSegmentsCount} new segments to playlist`);
              }
            });
          } else {
            // Schedule next segment
            setTimeout(streamNextSegment, segment.duration * 1000);
          }
        });

        // Handle segment error
        response.data.on('error', error => {
          self.logger.error(`Segment streaming error: ${error}`);
          currentIndex++;
          setTimeout(streamNextSegment, 1000); // Retry after 1 second
        });
      } catch (error) {
        self.logger.error(`Failed to fetch segment: ${error.message}`);
        currentIndex++;
        setTimeout(streamNextSegment, 1000); // Retry after 1 second
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

      // Find which segments are new (not already in currentSegments)
      const currentSegmentUrls = new Set(currentSegments.map(seg => seg.segmentUrl));

      // Find segments that are in the new playlist but not in the current one
      const segmentsToAdd = newSegments.filter(segment => !currentSegmentUrls.has(segment.segmentUrl));

      self.logger.info(`Found ${segmentsToAdd.length} new segments to add`);

      // Add only the new segments to the current playlist
      segmentsToAdd.forEach(segment => currentSegments.push(segment));

      // Call the callback with the number of new segments added
      continueCallback(segmentsToAdd.length);
    } catch (error) {
      self.logger.error(`Failed to refresh HLS playlist: ${error.message}`);
      // Retry after a short delay
      setTimeout(() => {
        self.refreshHlsPlaylist(playlistUrl, currentSegments, res, continueCallback);
      }, 1000);
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

    // Call parent stop method
    super.stop();
  }
}

module.exports = M3U8StreamingProxy;

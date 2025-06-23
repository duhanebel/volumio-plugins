'use strict';

const EventSource = require('eventsource');
const axios = require('axios');

let aisSessionId = null;
let eventSource = null;

// Start streaming to get AISSessionId
function startStreaming(userId) {
    const currentEpoch = Math.floor(Date.now() / 1000);
    const streamUrl = 'https://stream-mz.hellorayo.co.uk/planetrock_premhigh.aac?' +
        'direct=false' +
        '&listenerid=' + userId +
        '&aw_0_1st.bauer_listenerid=' + userId +
        '&aw_0_1st.playerid=BMUK_inpage_html5' +
        '&aw_0_1st.skey=' + currentEpoch +
        '&aw_0_1st.bauer_loggedin=true' +
        '&user_id=' + userId +
        '&aw_0_1st.bauer_user_id=' + userId +
        '&region=GB';

    console.log('Starting stream to get AISSessionId...');
    console.log('Stream URL:', streamUrl);

    // Start the stream request
    axios({
        method: 'get',
        url: streamUrl,
        responseType: 'stream',
        headers: {
            'Accept': '*/*',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3.1 Safari/605.1.15'
        },
        httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false })
    })
    .then(response => {
        console.log('Stream response status:', response.status);
        console.log('Stream response headers:', response.headers);

        // Get cookies from response
        const cookies = response.headers['set-cookie'];
        if (cookies) {
            console.log('Received cookies:', cookies);
            for (const cookie of cookies) {
                if (cookie.startsWith('AISSessionId=')) {
                    aisSessionId = cookie.split(';')[0];
                    console.log('Captured AISSessionId:', aisSessionId);
                    // Start metadata connection once we have the session ID
                    setupEventSource();
                    break;
                }
            }
        }

        // Keep consuming the stream data
        response.data.on('data', chunk => {
            // Just consume the data to keep the stream alive
        });

        response.data.on('end', () => {
            console.log('Stream ended, restarting...');
            // Restart the stream if it ends
            startStreaming(userId);
        });

        response.data.on('error', error => {
            console.error('Stream error:', error);
            // Restart the stream on error
            setTimeout(() => startStreaming(userId), 1000);
        });
    })
    .catch(error => {
        console.error('Stream request error:', error);
        // Restart the stream on error
        setTimeout(() => startStreaming(userId), 1000);
    });
}

// Setup EventSource connection
function setupEventSource() {
    if (!aisSessionId) {
        console.error('No AISSessionId available for EventSource connection');
        return;
    }

    const url = 'https://stream-mz.hellorayo.co.uk/metadata?type=json';
    console.log('Connecting to EventSource URL:', url);
    
    const options = {
        headers: {
            'Cookie': aisSessionId,
            'Accept': 'text/event-stream',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3.1 Safari/605.1.15'
        },
        rejectUnauthorized: false
    };

    console.log('EventSource options:', JSON.stringify(options, null, 2));

    // Close existing EventSource if any
    if (eventSource) {
        console.log('Closing existing EventSource connection');
        eventSource.close();
    }

    // Create new EventSource connection
    eventSource = new EventSource(url, options);

    eventSource.onopen = function() {
        const timestamp = new Date().toISOString();
        console.log(`[${timestamp}] EventSource connection established`);
        console.log(`[${timestamp}] EventSource readyState:`, eventSource.readyState);
    };

    eventSource.onerror = function(error) {
        const timestamp = new Date().toISOString();
        console.error(`[${timestamp}] EventSource error details:`);
        console.error(`[${timestamp}] - ReadyState:`, eventSource.readyState);
        
        // If connection is closed, restart it
        if (eventSource.readyState === EventSource.CLOSED) {
            console.log(`[${timestamp}] Connection closed, restarting...`);
            setTimeout(setupEventSource, 1000);
        }
    };

    eventSource.onmessage = function(event) {
        const timestamp = new Date().toISOString();
        console.log(`[${timestamp}] Received EventSource message:`, event.data);
        
        try {
            const messageData = JSON.parse(event.data);
            console.log(`[${timestamp}] Parsed EventSource message:`, JSON.stringify(messageData, null, 2));
            
            if (messageData['metadata-list'] && messageData['metadata-list'].length > 0) {
                const metadata = messageData['metadata-list'][0].metadata;
                console.log(`[${timestamp}] Extracted metadata string:`, metadata);
                
                // Parse the metadata string which is in format: key="value",key2="value2"
                const metadataObj = {};
                metadata.split(',').forEach(pair => {
                    const [key, value] = pair.split('=');
                    if (key && value) {
                        // Remove quotes from value
                        metadataObj[key] = value.replace(/^"|"$/g, '');
                    }
                });
                
                console.log(`[${timestamp}] Parsed metadata object:`, JSON.stringify(metadataObj, null, 2));
                
                // If we have a URL, fetch the track data
                if (metadataObj.url) {
                    // Skip the -1 event data URL
                    if (metadataObj.url.endsWith('/eventdata/-1')) {
                        console.log(`[${timestamp}] Skipping -1 event data URL`);
                        return;
                    }

                    // Fetch track data from the API
                    console.log(`[${timestamp}] Fetching event data from:`, metadataObj.url);
                    axios.get(metadataObj.url)
                        .then(response => {
                            console.log(`[${timestamp}] Event data response:`, JSON.stringify(response.data, null, 2));
                        })
                        .catch(error => {
                            console.error(`[${timestamp}] Failed to fetch event data:`, error.message);
                            console.error(`[${timestamp}] Error details:`, JSON.stringify(error, null, 2));
                        });
                }
            }
        } catch (error) {
            console.error(`[${timestamp}] Failed to parse EventSource message:`, error);
            console.error(`[${timestamp}] Raw message data:`, event.data);
        }
    };
}

// Main execution
console.log('Starting test...');
// Use hardcoded user ID
const testUserId = '2021352396';
startStreaming(testUserId); 
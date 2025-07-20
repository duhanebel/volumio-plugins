const axios = require('axios');

async function testStations() {
  try {
    const apiUrl = 'https://listenapi.planetradio.co.uk/api9.2/initweb/pln';
    const response = await axios.get(apiUrl);
    if (!response.data) {
      throw new Error('No station data in API response');
    }
    const mainStation = response.data;
    const brandId = mainStation.stationBrandId;
    const stations = [mainStation];
    if (Array.isArray(response.data.stationBrandRelated)) {
      response.data.stationBrandRelated.forEach(station => {
        if (station.stationBrandId === brandId) {
          stations.push(station);
        }
      });
    }

    console.log('--- Planet Radio Stations ---');
    stations.forEach((station, idx) => {
      console.log(`\n[${idx === 0 ? 'MAIN' : 'RELATED'}] ${station.stationName}`);
      console.log('  stationCode:', station.stationCode);
      console.log('  stationBrandId:', station.stationBrandId);
      console.log('  stationHeaderLogo:', station.stationHeaderLogo);
      if (idx === 0) {
        // Main station: resolve stream URL
        let streamUrl = null;
        if (Array.isArray(station.stationStreams)) {
          const stream = station.stationStreams.find(s => s.streamType === 'adts' && s.streamQuality === 'hq' && s.streamPremium === true);
          if (stream) {
            streamUrl = stream.streamUrl;
          }
        }
        if (!streamUrl) {
          console.log('  [WARN] No suitable stream found for main station');
        } else {
          const currentEpoch = Math.floor(Date.now() / 1000);
          const finalStreamUrl =
            `${streamUrl}?direct=false` +
            '&listenerid=TESTUSER' +
            '&aw_0_1st.bauer_listenerid=TESTUSER' +
            '&aw_0_1st.playerid=BMUK_inpage_html5' +
            `&aw_0_1st.skey=${currentEpoch}&aw_0_1st.bauer_loggedin=true` +
            '&user_id=TESTUSER' +
            '&aw_0_1st.bauer_user_id=TESTUSER' +
            '&region=GB';
          console.log('  streamUrl:', finalStreamUrl);
        }
      } else {
        // Related station: show custom URI
        console.log('  customUri:', `planetradio/${station.stationCode}`);
      }
    });
    console.log('\n--- End of Station List ---');
  } catch (err) {
    console.error('Error fetching or parsing stations:', err);
  }
}

testStations();

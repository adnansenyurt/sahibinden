/**
 * Main function to calculate the "openness" on four sides of a given coordinate.
 * @param {number} lat The latitude of the central point.
 * @param {number} lon The longitude of the central point.
 * @returns {Promise<object>} A promise that resolves to an object with openness status for N, E, S, W.
 * Example: { North: { status: 'Open', reason: 'Park' }, South: { status: 'Blocked', reason: 'Building' }, ... }
 */
async function calculateOpenness(lat, lon, selectedDirections) {
    const all = ['North', 'East', 'South', 'West'];
    const directions = Array.isArray(selectedDirections) && selectedDirections.length > 0 ? selectedDirections : all;
    const results = {};

    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    for (const direction of directions) {
        try {
            // Be polite to Overpass: brief delay between directional queries to avoid 429 rate limits
            const jitter = Math.floor(Math.random() * 250);
            await sleep(800 + jitter);
            // 1. Define the search area (a rectangle) for the current direction.
            const polygon = getSearchPolygon(lat, lon, direction);

            // 2. Build the API query with this polygon.
            const query = buildOverpassQuery(polygon);

            // 3. Call the Overpass API.
            const data = await queryOverpass(query);

            // 4. Analyze the returned map features to determine the status.
            results[direction] = analyzeZoneResults(data);
        } catch (error) {
            // Swallow logging for openness; keep result consistency
            results[direction] = { status: 'Error', reason: error.message };
        }
    }

    return results;
}

/**
 * Analyzes the JSON response from Overpass API for a single zone.
 * @param {object} data - The GeoJSON data from the API.
 * @returns {object} An object describing the zone's status.
 */
function analyzeZoneResults(data) {
    const elements = data.elements || [];

    if (elements.length === 0) {
        return { status: 'Open', reason: 'Empty Lot' };
    }

    // Check for explicitly "open" features first (parks, parking lots, etc.)
    const openFeature = elements.find(el =>
        el.tags && (el.tags.leisure === 'park' || el.tags.amenity === 'parking' || el.tags.landuse === 'grass')
    );

    if (openFeature) {
        const reason = openFeature.tags.leisure || openFeature.tags.amenity || openFeature.tags.landuse;
        return { status: 'Open', reason: `Contains '${reason}'` };
    }

    // If no open features, assume any remaining elements are buildings and check their height.
    let maxLevels = 0;
    const buildings = elements.filter(el => el.tags && el.tags.building);

    if (buildings.length === 0) {
        // This can happen if the zone contains minor features like fences or walls but no buildings.
        return { status: 'Open', reason: 'No significant structures' };
    }

    buildings.forEach(building => {
        if (building.tags['building:levels']) {
            const levels = parseInt(building.tags['building:levels'], 10);
            if (!isNaN(levels) && levels > maxLevels) {
                maxLevels = levels;
            }
        }
    });

    if (maxLevels > 2) {
        return { status: 'Blocked', reason: `Building (${maxLevels} floors)` };
    } else if (maxLevels > 0) {
        return { status: 'Open (Low-Rise)', reason: `Low-rise building (${maxLevels} floor/s)` };
    } else {
        return { status: 'Blocked', reason: 'Building (Unknown Height)' };
    }
}


/**
 * Sends a query to the Overpass API.
 * @param {string} query - The Overpass QL query string.
 * @returns {Promise<object>} The JSON response from the API.
 */
async function queryOverpass(query) {
    // Multiple public Overpass endpoints to reduce rate-limit errors (429) and improve reliability.
    // Note: Content scripts can fetch these directly; no manifest update is required for CORS in most cases.
    const ENDPOINTS = [
        'https://overpass-api.de/api/interpreter',
        'https://overpass.kumi.systems/api/interpreter',
        'https://overpass.openstreetmap.ru/api/interpreter',
        'https://overpass.nchc.org.tw/api/interpreter',
        'https://overpass.openstreetmap.fr/api/interpreter'
    ];

    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    // Try POST first; on 429/5xx or network failure, rotate endpoint and/or fall back to GET with ?data=
    const maxAttemptsPerEndpoint = 3; // attempts before switching endpoint
    const maxTotalAttempts = ENDPOINTS.length * maxAttemptsPerEndpoint;

    let attempt = 0;
    let endpointIndex = 0;
    let lastError = null;

    while (attempt < maxTotalAttempts) {
        const endpoint = ENDPOINTS[endpointIndex % ENDPOINTS.length];
        const useGet = attempt % maxAttemptsPerEndpoint === 1; // second try on same endpoint uses GET
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 25000);
            let response;
            if (!useGet) {
                response = await fetch(endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
                    body: `data=${encodeURIComponent(query)}`,
                    signal: controller.signal
                });
            } else {
                const url = `${endpoint}?data=${encodeURIComponent(query)}`;
                response = await fetch(url, { method: 'GET', signal: controller.signal });
            }
            clearTimeout(timeoutId);

            if (response.ok) {
                return await response.json();
            }

            // Handle rate limiting and server errors with backoff and endpoint rotation
            const status = response.status;
            lastError = new Error(`Overpass API error: ${status} ${response.statusText}`);

            // For 429 or 5xx, apply exponential backoff then rotate
            if (status === 429 || (status >= 500 && status <= 599)) {
                const base = 1000 * Math.pow(2, Math.floor(attempt / ENDPOINTS.length));
                const jitter = Math.floor(Math.random() * 500);
                const backoffMs = base + jitter;
                await sleep(backoffMs);
                // Switch to next endpoint after two attempts on same one
                if ((attempt + 1) % maxAttemptsPerEndpoint === 0) {
                    endpointIndex++;
                }
                attempt++;
                continue;
            }

            // For other HTTP errors, do not retry endlessly
            throw lastError;
        } catch (e) {
            // Network/abort or JSON parse errors
            lastError = e instanceof Error ? e : new Error(String(e));
            const base = 1000 * Math.pow(2, Math.floor(attempt / ENDPOINTS.length));
            const jitter = Math.floor(Math.random() * 500);
            const backoffMs = base + jitter;
            await sleep(backoffMs);
            if ((attempt + 1) % maxAttemptsPerEndpoint === 0) {
                endpointIndex++;
            }
            attempt++;
        }
    }

    throw new Error(lastError && lastError.message ? lastError.message : 'Overpass API request failed');
}

/**
 * Constructs the Overpass QL query string.
 * @param {string} polygonString - A string of "lat lon lat lon..." coordinates.
 * @returns {string} The full query.
 */
function buildOverpassQuery(polygonString) {
    return `
      [out:json][timeout:25];
      (
        way["building"](poly:"${polygonString}");
        way["leisure"~"park|playground"](poly:"${polygonString}");
        way["amenity"="parking"](poly:"${polygonString}");
        way["landuse"~"grass|meadow"](poly:"${polygonString}");
      );
      out body;
      >;
      out skel qt;
    `;
}

/**
 * Calculates the four corner coordinates of a rectangular search zone.
 * @param {number} centerLat - Center latitude.
 * @param {number} centerLon - Center longitude.
 * @param {string} direction - 'North', 'East', 'South', or 'West'.
 * @param {number} lengthMeters - The length of the box extending from the center.
 * @param {number} widthMeters - The total width of the box.
 * @returns {string} A space-separated string of lat/lon pairs for the polygon.
 */
function getSearchPolygon(centerLat, centerLon, direction, lengthMeters = 50, widthMeters = 30) {
    // Approximate conversions: 1 degree of latitude is ~111.32 km. Longitude varies.
    const metersPerDegreeLat = 111320;
    const metersPerDegreeLon = 40075000 * Math.cos(centerLat * Math.PI / 180) / 360;

    const latLen = lengthMeters / metersPerDegreeLat;
    const lonLen = lengthMeters / metersPerDegreeLon;
    const latWidth = (widthMeters / 2) / metersPerDegreeLat;
    const lonWidth = (widthMeters / 2) / metersPerDegreeLon;

    let p1, p2, p3, p4;

    switch (direction) {
        case 'North':
            p1 = { lat: centerLat,          lon: centerLon - lonWidth };
            p2 = { lat: centerLat,          lon: centerLon + lonWidth };
            p3 = { lat: centerLat + latLen, lon: centerLon + lonWidth };
            p4 = { lat: centerLat + latLen, lon: centerLon - lonWidth };
            break;
        case 'South':
            p1 = { lat: centerLat,          lon: centerLon - lonWidth };
            p2 = { lat: centerLat,          lon: centerLon + lonWidth };
            p3 = { lat: centerLat - latLen, lon: centerLon + lonWidth };
            p4 = { lat: centerLat - latLen, lon: centerLon - lonWidth };
            break;
        case 'East':
            p1 = { lat: centerLat - latWidth, lon: centerLon };
            p2 = { lat: centerLat + latWidth, lon: centerLon };
            p3 = { lat: centerLat + latWidth, lon: centerLon + lonLen };
            p4 = { lat: centerLat - latWidth, lon: centerLon + lonLen };
            break;
        case 'West':
            p1 = { lat: centerLat - latWidth, lon: centerLon };
            p2 = { lat: centerLat + latWidth, lon: centerLon };
            p3 = { lat: centerLat + latWidth, lon: centerLon - lonLen };
            p4 = { lat: centerLat - latWidth, lon: centerLon - lonLen };
            break;
    }

    // Format for Overpass API: "lat1 lon1 lat2 lon2 ..."
    return `${p1.lat} ${p1.lon} ${p2.lat} ${p2.lon} ${p3.lat} ${p3.lon} ${p4.lat} ${p4.lon}`;
}
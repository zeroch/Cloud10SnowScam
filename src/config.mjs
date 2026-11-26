// Fixed ski-area points, never visitor coordinates. Elevation is the requested
// forecast reference, not the model's resolved terrain or a station observation.
export const RESORTS = [
  { id: 'stevenspass', name: 'Stevens Pass', latitude: 47.7376, longitude: -121.1073, elevationFt: 4800, pointLabel: 'Brooks', reportLabel: 'NWAC Brooks', reportUrl: 'https://nwac.us/weather/stations/stevens-pass-brooks', camerasUrl: 'https://www.stevenspass.com/the-mountain/mountain-conditions/mountain-cams.aspx' },
  { id: 'crystalmountain', name: 'Crystal Mountain', latitude: 46.9351, longitude: -121.4747, elevationFt: 5600, pointLabel: 'Mid-mountain', reportLabel: 'Crystal Mountain report', reportUrl: 'https://www.crystalmountainresort.com/the-mountain/mountain-report-and-webcams', camerasUrl: 'https://www.crystalmountainresort.com/the-mountain/mountain-report-and-webcams' },
  { id: 'summitcentral', name: 'Summit Central', latitude: 47.4101, longitude: -121.4135, elevationFt: 3400, pointLabel: 'Mid-mountain', reportLabel: 'Summit mountain report', reportUrl: 'https://www.summitatsnoqualmie.com/mountain-report', camerasUrl: 'https://www.summitatsnoqualmie.com/webcams' },
  { id: 'mtbaker', name: 'Mt. Baker', latitude: 48.8619, longitude: -121.6821, elevationFt: 4300, pointLabel: 'Mid-mountain', reportLabel: 'Mt. Baker snow report', reportUrl: 'https://www.mtbaker.us/snow-report/', camerasUrl: 'https://www.mtbaker.us/snow-report/' },
].map(resort => Object.freeze({ ...resort, elevationM: Number((resort.elevationFt * .3048).toFixed(2)), timezone: 'America/Los_Angeles',
  // Extend the existing personal Stevens elevation gaps, rounded to 100 ft.
  // These are preferences, not a calibrated prediction of snow density.
  snowLevelBands: { dry: Math.max(0, Math.round((resort.elevationFt - 2800) / 100) * 100), wet: Math.round((resort.elevationFt - 800) / 100) * 100 },
}));
export const RESORT = RESORTS[0];
export const getResort = (id = RESORT.id) => RESORTS.find(resort => resort.id === id);
export const snowLevelBands = resort => getResort(resort?.id)?.snowLevelBands || RESORT.snowLevelBands;
export function resortCacheKey(resort, source) {
  if (source !== 'forecast') return resort.id === RESORT.id ? source : `${resort.id}-${source}`;
  // Preserve the unchanged Brooks history. Other forecast points include their
  // requested terrain so an elevation change cannot relabel an older snapshot.
  if (resort.id === RESORT.id) return `${resort.id}-forecast-v2`;
  const point = `${resort.latitude}-${resort.longitude}-${resort.elevationM}`.replaceAll('.', 'p');
  return `${resort.id}-forecast-v2-${point}`;
}
export const MODELS = [
  { id: 'ecmwf_ifs025', label: 'ECMWF', description: 'European IFS', color: '#127b83' },
  { id: 'gfs_global', label: 'GFS', description: 'American global', color: '#b5763e' },
  { id: 'icon_global', label: 'ICON', description: 'German global', color: '#7872b0' },
  { id: 'gem_global', label: 'GDPS', description: 'Canadian global', color: '#3476ac' },
  { id: 'gfs_hrrr', label: 'HRRR', description: 'American high resolution · short range', color: '#ce5776' },
];
export const STATION_PAGES = {
  brooks: { slug: 'stevens-pass-brooks', name: 'NWAC Brooks', stations: [{ id: 'brooks', stid: '50', name: 'Brooks', elevationFt: 4800 }] },
  schmidt: { slug: 'stevens-pass-schmidt-haus', name: 'NWAC Schmidt Haus', stations: [{ id: 'schmidt', stid: '13', name: 'Schmidt Haus', elevationFt: 3950 }] },
  upper: { slug: 'stevens-ski-area', name: 'NWAC upper mountain', stations: [{ id: 'tye', stid: '18', name: 'Tye Mill', elevationFt: 5180 }, { id: 'skyline', stid: '17', name: 'Skyline', elevationFt: 5250 }] },
};
export const stationUrl = page => `https://nwac.us/weather/stations/${page.slug}`;

// Selected weather stations and road corridors for the resort conditions cards.
export const MORNING_RESORTS = Object.freeze({
  stevenspass: {
    station: { ...STATION_PAGES.brooks.stations[0], slug: STATION_PAGES.brooks.slug },
    road: { passName: 'Stevens Pass US 2', url: 'https://wsdot.com/travel/real-time/mountainpasses/stevens' },
  },
  crystalmountain: {
    station: { stid: '54', slug: 'crystal-mt-green-valley', name: 'Campbell Basin', elevationFt: 5940 },
    road: { passName: 'Crystal to Greenwater SR 410', url: 'https://wsdot.com/travel/real-time/mountainpasses' },
  },
  summitcentral: {
    station: { stid: '23', slug: 'snoqualmie-pass', name: 'Snoqualmie Pass East Shed', elevationFt: 3770 },
    road: { passName: 'Snoqualmie Pass I-90', url: 'https://wsdot.com/travel/real-time/mountainpasses/snoqualmie' },
  },
  mtbaker: {
    station: { stid: '5', slug: 'mt-baker-ski-area', name: 'Heather Meadows', elevationFt: 4210 },
    road: { passName: 'Mt. Baker Hwy SR 542', url: 'https://wsdot.com/travel/real-time/mountainpasses' },
  },
});

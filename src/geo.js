// Geographic seeds for query fan-out. Broad coverage beats a short list here:
// most facility sites only surface for a city-scoped query.
export const NY_MARKETS = [
  // NYC + metro
  'New York NY', 'Manhattan NY', 'Brooklyn NY', 'Queens NY', 'Bronx NY', 'Staten Island NY',
  'Yonkers NY', 'New Rochelle NY', 'White Plains NY', 'Mount Vernon NY', 'Scarsdale NY',
  'Mamaroneck NY', 'Rye NY', 'Port Chester NY', 'Ossining NY', 'Peekskill NY',
  'Tarrytown NY', 'Elmsford NY', 'Armonk NY', 'Mount Kisco NY', 'Bedford NY',
  // Long Island
  'Hempstead NY', 'Garden City NY', 'Mineola NY', 'Freeport NY', 'Long Beach NY',
  'Glen Cove NY', 'Great Neck NY', 'Manhasset NY', 'Syosset NY', 'Plainview NY',
  'Hicksville NY', 'Farmingdale NY', 'Bethpage NY', 'Massapequa NY', 'Huntington NY',
  'Melville NY', 'Commack NY', 'Smithtown NY', 'Islandia NY', 'Hauppauge NY',
  'Bay Shore NY', 'Islip NY', 'Sayville NY', 'Patchogue NY', 'Bohemia NY',
  'Ronkonkoma NY', 'Holbrook NY', 'Medford NY', 'Riverhead NY', 'Southampton NY',
  'East Hampton NY', 'Bridgehampton NY', 'Montauk NY', 'Port Jefferson NY', 'Stony Brook NY',
  // Hudson Valley
  'Poughkeepsie NY', 'Fishkill NY', 'Beacon NY', 'Newburgh NY', 'Middletown NY',
  'Goshen NY', 'Monroe NY', 'Warwick NY', 'Nyack NY', 'Nanuet NY', 'Spring Valley NY',
  'Suffern NY', 'New City NY', 'Pearl River NY', 'Kingston NY', 'New Paltz NY',
  'Saugerties NY', 'Hudson NY', 'Catskill NY', 'Carmel NY', 'Brewster NY', 'Mahopac NY',
  // Capital Region
  'Albany NY', 'Schenectady NY', 'Troy NY', 'Saratoga Springs NY', 'Clifton Park NY',
  'Latham NY', 'Colonie NY', 'Guilderland NY', 'Delmar NY', 'Malta NY', 'Glens Falls NY',
  'Queensbury NY', 'Amsterdam NY', 'Gloversville NY', 'Hudson Falls NY',
  // Central NY / Mohawk Valley
  'Syracuse NY', 'Liverpool NY', 'Cicero NY', 'Baldwinsville NY', 'Camillus NY',
  'Manlius NY', 'Fayetteville NY', 'Auburn NY', 'Cortland NY', 'Oswego NY', 'Fulton NY',
  'Utica NY', 'Rome NY', 'New Hartford NY', 'Herkimer NY', 'Oneida NY', 'Hamilton NY',
  // Southern Tier
  'Binghamton NY', 'Vestal NY', 'Endicott NY', 'Johnson City NY', 'Ithaca NY',
  'Elmira NY', 'Corning NY', 'Horseheads NY', 'Bath NY', 'Olean NY', 'Jamestown NY',
  // Finger Lakes / Rochester
  'Rochester NY', 'Brighton NY', 'Pittsford NY', 'Penfield NY', 'Webster NY',
  'Greece NY', 'Henrietta NY', 'Fairport NY', 'Victor NY', 'Canandaigua NY',
  'Geneva NY', 'Newark NY', 'Batavia NY', 'Brockport NY', 'Geneseo NY',
  // Western NY / Buffalo
  'Buffalo NY', 'Amherst NY', 'Cheektowaga NY', 'Tonawanda NY', 'West Seneca NY',
  'Orchard Park NY', 'Hamburg NY', 'Lancaster NY', 'Clarence NY', 'Williamsville NY',
  'Niagara Falls NY', 'Lockport NY', 'Lewiston NY', 'Dunkirk NY', 'Fredonia NY',
  // North Country
  'Watertown NY', 'Plattsburgh NY', 'Potsdam NY', 'Canton NY', 'Massena NY',
  'Ogdensburg NY', 'Lake Placid NY', 'Saranac Lake NY', 'Malone NY',
];

// Region labels used only for progress reporting / notes.
export const NY_REGIONS = [
  'New York City', 'Westchester', 'Long Island', 'Hudson Valley', 'Capital Region',
  'Central New York', 'Mohawk Valley', 'Southern Tier', 'Finger Lakes', 'Western New York',
  'North Country',
];

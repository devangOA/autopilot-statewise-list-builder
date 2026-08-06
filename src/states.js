// Per-state configuration. Everything geographic lives here so a new state is
// a data change, not a code change: add an entry and the whole pipeline -
// discovery fan-out, city parsing, address parsing and the location gate -
// follows it.
import { NY_MARKETS } from './geo.js';

// Two-label public suffixes are handled in search.js; this is only the
// state-owned government space that is out of scope per the brief.
const GOV = (code) => [/\.gov$/i, /\.mil$/i, new RegExp(`\\.${code.toLowerCase()}\\.us$`, 'i')];

const CA_MARKETS = [
  // Los Angeles County
  'Los Angeles CA', 'Long Beach CA', 'Glendale CA', 'Pasadena CA', 'Torrance CA',
  'Santa Monica CA', 'Burbank CA', 'El Segundo CA', 'Culver City CA', 'Inglewood CA',
  'Redondo Beach CA', 'Manhattan Beach CA', 'Hermosa Beach CA', 'Carson CA', 'Cerritos CA',
  'Downey CA', 'Norwalk CA', 'Whittier CA', 'Lakewood CA', 'Compton CA',
  'Santa Clarita CA', 'Valencia CA', 'Lancaster CA', 'Palmdale CA', 'Woodland Hills CA',
  'Sherman Oaks CA', 'Van Nuys CA', 'Northridge CA', 'Encino CA', 'Studio City CA',
  'West Covina CA', 'Pomona CA', 'Arcadia CA', 'Monrovia CA', 'Alhambra CA',
  'El Monte CA', 'Rosemead CA', 'Diamond Bar CA', 'Walnut CA', 'San Gabriel CA',
  'Hawthorne CA', 'Gardena CA', 'Bellflower CA', 'Paramount CA', 'Montebello CA',
  // Orange County
  'Anaheim CA', 'Irvine CA', 'Santa Ana CA', 'Huntington Beach CA', 'Newport Beach CA',
  'Costa Mesa CA', 'Fullerton CA', 'Orange CA', 'Tustin CA', 'Mission Viejo CA',
  'Laguna Niguel CA', 'Lake Forest CA', 'Yorba Linda CA', 'Brea CA', 'Buena Park CA',
  'Garden Grove CA', 'Westminster CA', 'Fountain Valley CA', 'Aliso Viejo CA',
  'San Clemente CA', 'Dana Point CA', 'Rancho Santa Margarita CA', 'Cypress CA', 'Placentia CA',
  // San Diego County
  'San Diego CA', 'Carlsbad CA', 'Encinitas CA', 'Oceanside CA', 'Vista CA',
  'Escondido CA', 'San Marcos CA', 'Chula Vista CA', 'La Jolla CA', 'Poway CA',
  'El Cajon CA', 'La Mesa CA', 'Santee CA', 'Coronado CA', 'Del Mar CA',
  'Rancho Bernardo CA', 'Solana Beach CA', 'National City CA', 'Imperial Beach CA',
  // Inland Empire - Riverside & San Bernardino
  'Riverside CA', 'San Bernardino CA', 'Ontario CA', 'Rancho Cucamonga CA', 'Fontana CA',
  'Corona CA', 'Temecula CA', 'Murrieta CA', 'Moreno Valley CA', 'Redlands CA',
  'Chino CA', 'Chino Hills CA', 'Upland CA', 'Claremont CA', 'Hemet CA',
  'Menifee CA', 'Perris CA', 'Victorville CA', 'Apple Valley CA', 'Hesperia CA',
  'Palm Springs CA', 'Palm Desert CA', 'La Quinta CA', 'Indio CA', 'Rancho Mirage CA',
  'Eastvale CA', 'Jurupa Valley CA', 'Yucaipa CA', 'Colton CA', 'Rialto CA',
  // Ventura & Santa Barbara
  'Ventura CA', 'Oxnard CA', 'Thousand Oaks CA', 'Simi Valley CA', 'Camarillo CA',
  'Westlake Village CA', 'Moorpark CA', 'Santa Barbara CA', 'Goleta CA', 'Carpinteria CA',
  'Santa Maria CA', 'Lompoc CA', 'Ojai CA',
  // Central Coast & Monterey Bay
  'San Luis Obispo CA', 'Paso Robles CA', 'Atascadero CA', 'Pismo Beach CA', 'Arroyo Grande CA',
  'Santa Cruz CA', 'Watsonville CA', 'Scotts Valley CA', 'Monterey CA', 'Salinas CA',
  'Seaside CA', 'Marina CA', 'Carmel CA', 'Hollister CA', 'Gilroy CA', 'Morgan Hill CA',
  // Bay Area - San Francisco & Peninsula
  'San Francisco CA', 'Daly City CA', 'South San Francisco CA', 'San Mateo CA', 'Burlingame CA',
  'Redwood City CA', 'Menlo Park CA', 'Palo Alto CA', 'Foster City CA', 'San Bruno CA',
  'Millbrae CA', 'Belmont CA', 'San Carlos CA', 'Half Moon Bay CA', 'Pacifica CA',
  // Silicon Valley
  'San Jose CA', 'Santa Clara CA', 'Sunnyvale CA', 'Mountain View CA', 'Cupertino CA',
  'Milpitas CA', 'Campbell CA', 'Los Gatos CA', 'Saratoga CA', 'Los Altos CA',
  'Fremont CA', 'Newark CA', 'Union City CA',
  // East Bay
  'Oakland CA', 'Berkeley CA', 'Alameda CA', 'San Leandro CA', 'Hayward CA',
  'Pleasanton CA', 'Dublin CA', 'Livermore CA', 'San Ramon CA', 'Danville CA',
  'Walnut Creek CA', 'Concord CA', 'Pleasant Hill CA', 'Martinez CA', 'Antioch CA',
  'Brentwood CA', 'Pittsburg CA', 'Richmond CA', 'El Cerrito CA', 'Castro Valley CA',
  'Lafayette CA', 'Orinda CA', 'Moraga CA', 'Emeryville CA',
  // North Bay
  'Santa Rosa CA', 'Petaluma CA', 'Novato CA', 'San Rafael CA', 'Mill Valley CA',
  'Napa CA', 'Vallejo CA', 'Fairfield CA', 'Vacaville CA', 'Benicia CA',
  'Sonoma CA', 'Rohnert Park CA', 'Windsor CA', 'Healdsburg CA', 'Corte Madera CA',
  // Sacramento region
  'Sacramento CA', 'Roseville CA', 'Folsom CA', 'Elk Grove CA', 'Rocklin CA',
  'Citrus Heights CA', 'Rancho Cordova CA', 'Davis CA', 'Woodland CA', 'El Dorado Hills CA',
  'Lincoln CA', 'Auburn CA', 'Granite Bay CA', 'West Sacramento CA', 'Yuba City CA',
  // Central Valley - Stockton, Modesto, Fresno, Bakersfield
  'Stockton CA', 'Modesto CA', 'Tracy CA', 'Manteca CA', 'Lodi CA', 'Turlock CA',
  'Ceres CA', 'Ripon CA', 'Fresno CA', 'Clovis CA', 'Visalia CA', 'Tulare CA',
  'Hanford CA', 'Madera CA', 'Merced CA', 'Los Banos CA', 'Bakersfield CA',
  'Delano CA', 'Porterville CA', 'Ridgecrest CA',
  // North Coast & Far Northern California
  'Eureka CA', 'Arcata CA', 'Ukiah CA', 'Fort Bragg CA', 'Redding CA',
  'Chico CA', 'Paradise CA', 'Oroville CA', 'Red Bluff CA', 'Susanville CA',
  'Grass Valley CA', 'Nevada City CA', 'Truckee CA', 'South Lake Tahoe CA', 'Placerville CA',
  'Marysville CA', 'Anderson CA', 'Willows CA',
];

// Municipalities used to pick the real city out of an address line.
const CA_PLACES = new Set(
  CA_MARKETS.map((m) => m.replace(/\s+CA$/, '').toLowerCase()).concat([
    'north hollywood', 'canoga park', 'reseda', 'tarzana', 'chatsworth', 'granada hills',
    'playa vista', 'marina del rey', 'venice', 'brentwood heights', 'westwood', 'hollywood',
    'san pedro', 'wilmington', 'harbor city', 'rolling hills', 'palos verdes',
    'rancho palos verdes', 'la canada flintridge', 'sierra madre', 'temple city',
    'south pasadena', 'san marino', 'la verne', 'san dimas', 'glendora', 'azusa', 'covina',
    'baldwin park', 'la mirada', 'la habra', 'seal beach', 'los alamitos', 'stanton',
    'laguna beach', 'laguna hills', 'san juan capistrano', 'ladera ranch', 'coto de caza',
    'rancho penasquitos', 'carmel valley', 'mira mesa', 'clairemont', 'point loma',
    'pacific beach', 'ocean beach', 'lemon grove', 'spring valley', 'bonita', 'alpine',
    'ramona', 'fallbrook', 'temecula valley', 'wildomar', 'lake elsinore', 'canyon lake',
    'beaumont', 'banning', 'calimesa', 'loma linda', 'grand terrace', 'highland',
    'twentynine palms', 'yucca valley', 'barstow', 'adelanto', 'cathedral city',
    'desert hot springs', 'coachella', 'blythe', 'el centro', 'calexico', 'brawley',
    'agoura hills', 'calabasas', 'malibu', 'port hueneme', 'fillmore', 'santa paula',
    'goleta valley', 'buellton', 'solvang', 'grover beach', 'morro bay', 'nipomo',
    'aptos', 'capitola', 'felton', 'ben lomond', 'pacific grove', 'pebble beach',
    'king city', 'greenfield', 'soledad', 'san juan bautista', 'san benito',
    'brisbane', 'hillsborough', 'atherton', 'portola valley', 'woodside', 'east palo alto',
    'san anselmo', 'fairfax', 'larkspur', 'tiburon', 'sausalito', 'greenbrae',
    'american canyon', 'st helena', 'calistoga', 'yountville', 'dixon', 'rio vista',
    'suisun city', 'cotati', 'sebastopol', 'cloverdale', 'guerneville',
    'orangevale', 'fair oaks', 'carmichael', 'north highlands', 'antelope', 'galt',
    'loomis', 'penryn', 'newcastle', 'colfax', 'cameron park', 'shingle springs',
    'lathrop', 'escalon', 'oakdale', 'riverbank', 'patterson', 'newman', 'gustine',
    'atwater', 'livingston', 'chowchilla', 'kerman', 'sanger', 'reedley', 'selma',
    'kingsburg', 'dinuba', 'exeter', 'lindsay', 'shafter', 'wasco', 'taft',
    'tehachapi', 'california city', 'mcfarland', 'arvin', 'lamont',
    'mckinleyville', 'fortuna', 'crescent city', 'weaverville', 'mount shasta',
    'yreka', 'alturas', 'quincy', 'portola', 'colusa', 'orland', 'corning',
    'gridley', 'live oak', 'wheatland', 'rocklin hills', 'el dorado', 'jackson',
    'sonora', 'angels camp', 'mariposa', 'bishop', 'mammoth lakes',
  ]),
);


const FL_MARKETS = [
  'Miami FL', 'Miami Beach FL', 'Coral Gables FL', 'Hialeah FL', 'Doral FL', 'Kendall FL',
  'Fort Lauderdale FL', 'Hollywood FL', 'Pembroke Pines FL', 'Coral Springs FL', 'Plantation FL',
  'Sunrise FL', 'Davie FL', 'Weston FL', 'Boca Raton FL', 'Delray Beach FL', 'Boynton Beach FL',
  'West Palm Beach FL', 'Jupiter FL', 'Wellington FL', 'Palm Beach Gardens FL', 'Port St Lucie FL',
  'Stuart FL', 'Vero Beach FL', 'Naples FL', 'Bonita Springs FL', 'Fort Myers FL', 'Cape Coral FL',
  'Estero FL', 'Sarasota FL', 'Bradenton FL', 'Venice FL', 'Lakewood Ranch FL', 'Punta Gorda FL',
  'Tampa FL', 'St Petersburg FL', 'Clearwater FL', 'Brandon FL', 'Riverview FL', 'Wesley Chapel FL',
  'Lutz FL', 'Palm Harbor FL', 'Largo FL', 'Dunedin FL', 'Temple Terrace FL', 'Plant City FL',
  'Orlando FL', 'Winter Park FL', 'Winter Garden FL', 'Kissimmee FL', 'Altamonte Springs FL',
  'Lake Mary FL', 'Sanford FL', 'Oviedo FL', 'Clermont FL', 'Apopka FL', 'Ocoee FL', 'Celebration FL',
  'Jacksonville FL', 'Jacksonville Beach FL', 'Ponte Vedra FL', 'St Augustine FL', 'Orange Park FL',
  'Fleming Island FL', 'Fernandina Beach FL', 'Daytona Beach FL', 'Ormond Beach FL', 'Palm Coast FL',
  'Melbourne FL', 'Palm Bay FL', 'Viera FL', 'Cocoa FL', 'Titusville FL', 'Merritt Island FL',
  'Gainesville FL', 'Ocala FL', 'The Villages FL', 'Leesburg FL', 'Lady Lake FL',
  'Tallahassee FL', 'Panama City FL', 'Destin FL', 'Fort Walton Beach FL', 'Pensacola FL',
  'Niceville FL', 'Crestview FL', 'Santa Rosa Beach FL', 'Lakeland FL', 'Winter Haven FL',
  'Sebring FL', 'Key West FL', 'Marathon FL', 'Homestead FL', 'Miramar FL', 'Aventura FL',
];

const TN_MARKETS = [
  'Nashville TN', 'Franklin TN', 'Brentwood TN', 'Murfreesboro TN', 'Hendersonville TN',
  'Smyrna TN', 'Mount Juliet TN', 'Gallatin TN', 'Spring Hill TN', 'Lebanon TN', 'Nolensville TN',
  'Clarksville TN', 'Columbia TN', 'Dickson TN', 'Springfield TN', 'White House TN',
  'Memphis TN', 'Germantown TN', 'Collierville TN', 'Bartlett TN', 'Cordova TN', 'Arlington TN',
  'Millington TN', 'Jackson TN', 'Dyersburg TN', 'Union City TN', 'Martin TN',
  'Knoxville TN', 'Farragut TN', 'Maryville TN', 'Alcoa TN', 'Oak Ridge TN', 'Sevierville TN',
  'Pigeon Forge TN', 'Gatlinburg TN', 'Morristown TN', 'Jefferson City TN', 'Lenoir City TN',
  'Chattanooga TN', 'Cleveland TN', 'East Ridge TN', 'Hixson TN', 'Ooltewah TN', 'Signal Mountain TN',
  'Johnson City TN', 'Kingsport TN', 'Bristol TN', 'Elizabethton TN', 'Greeneville TN',
  'Cookeville TN', 'Crossville TN', 'McMinnville TN', 'Tullahoma TN', 'Shelbyville TN',
  'Manchester TN', 'Lawrenceburg TN', 'Pulaski TN', 'Fayetteville TN', 'Winchester TN',
  'Sparta TN', 'Livingston TN', 'Athens TN', 'Sweetwater TN', 'Harriman TN', 'Kingston TN',
];

// Markets double as the municipality whitelist; `extra` adds neighbourhoods and
// smaller towns that appear in addresses but are not worth querying separately.
const placeSet = (markets, extra = []) =>
  new Set(markets.map((m) => m.replace(/\s+[A-Z]{2}$/, '').toLowerCase()).concat(extra));

export const STATES = {
  NY: {
    code: 'NY',
    name: 'New York',
    // Matches "NY" or the spelled-out name in an address.
    stateRe: /(?:NY|New York)/,
    zipRe: /\bNY\s+1\d{4}\b/,
    zipBare: /^1\d{4}$/,
    areaCodes: /\(?(212|315|332|347|516|518|585|607|631|646|680|716|718|838|845|914|917|929|934)\)?[)\s.-]{1,3}\d{3}[\s.-]?\d{4}/,
    mentionRe: /\bNew York (?:State|City)\b/i,
    markets: NY_MARKETS,
    places: null, // supplied by extract.js NY_PLACES for backwards compatibility
    gov: GOV('NY').concat([/\.state\.ny\.us$/i]),
    statewide: [
      'indoor pickleball facilities New York State directory',
      'USTA Eastern indoor tennis facilities New York',
      'indoor sports complex New York State list',
      'New York volleyball clubs indoor facility list',
      'New York squash clubs list',
      'best indoor pickleball courts upstate New York',
      'sportsplex New York State',
    ],
  },
  CA: {
    code: 'CA',
    name: 'California',
    stateRe: /(?:CA|California|Calif\.?)/,
    // California ZIPs are 90000-96199.
    zipRe: /\b(?:CA|California)\s+9[0-6]\d{3}\b/,
    // California ZIPs run 90000-96199; anything else contradicts the state token.
    zipBare: /^9[0-6]\d{3}$/,
    areaCodes:
      /\(?(209|213|279|310|323|341|350|408|415|424|442|510|530|559|562|619|626|628|650|657|661|669|707|714|747|760|764|805|818|820|831|837|840|858|909|916|925|949|951)\)?[)\s.-]{1,3}\d{3}[\s.-]?\d{4}/,
    mentionRe: /\b(?:Southern|Northern|Central) California\b|\bCalifornia\b/i,
    markets: CA_MARKETS,
    // Dense markets worth all 31 query angles. Everywhere else gets the ten
    // highest-yield ones, which is what keeps total query volume inside what
    // the search engines will serve before they rate-limit collectively.
    majorMarkets: [
      'Los Angeles CA', 'Long Beach CA', 'Glendale CA', 'Pasadena CA', 'Torrance CA',
      'Santa Monica CA', 'Burbank CA', 'Culver City CA', 'Santa Clarita CA', 'Woodland Hills CA',
      'Sherman Oaks CA', 'Van Nuys CA', 'Northridge CA', 'West Covina CA', 'Pomona CA',
      'Anaheim CA', 'Irvine CA', 'Santa Ana CA', 'Huntington Beach CA', 'Newport Beach CA',
      'Costa Mesa CA', 'Fullerton CA', 'Orange CA', 'Mission Viejo CA', 'Garden Grove CA',
      'San Diego CA', 'Carlsbad CA', 'Encinitas CA', 'Oceanside CA', 'Escondido CA',
      'Chula Vista CA', 'La Jolla CA', 'Poway CA', 'El Cajon CA',
      'Riverside CA', 'San Bernardino CA', 'Ontario CA', 'Rancho Cucamonga CA', 'Corona CA',
      'Temecula CA', 'Murrieta CA', 'Redlands CA', 'Chino Hills CA', 'Palm Desert CA',
      'Ventura CA', 'Oxnard CA', 'Thousand Oaks CA', 'Simi Valley CA', 'Santa Barbara CA',
      'San Luis Obispo CA', 'Santa Cruz CA', 'Monterey CA', 'Salinas CA',
      'San Francisco CA', 'San Mateo CA', 'Redwood City CA', 'Palo Alto CA', 'Menlo Park CA',
      'San Jose CA', 'Santa Clara CA', 'Sunnyvale CA', 'Mountain View CA', 'Cupertino CA',
      'Fremont CA', 'Los Gatos CA', 'Campbell CA',
      'Oakland CA', 'Berkeley CA', 'Alameda CA', 'Hayward CA', 'Pleasanton CA',
      'Dublin CA', 'Livermore CA', 'San Ramon CA', 'Walnut Creek CA', 'Concord CA',
      'Santa Rosa CA', 'Petaluma CA', 'San Rafael CA', 'Napa CA', 'Vallejo CA', 'Fairfield CA',
      'Sacramento CA', 'Roseville CA', 'Folsom CA', 'Elk Grove CA', 'Rocklin CA', 'Davis CA',
      'Stockton CA', 'Modesto CA', 'Tracy CA', 'Fresno CA', 'Clovis CA', 'Visalia CA',
      'Merced CA', 'Bakersfield CA', 'Redding CA', 'Chico CA', 'Eureka CA', 'Truckee CA',
    ],
    places: CA_PLACES,
    gov: GOV('CA'),
    statewide: [
      'indoor pickleball facilities California directory',
      'USTA Southern California indoor tennis facilities',
      'USTA Northern California indoor tennis clubs',
      'indoor sports complex California list',
      'California volleyball clubs indoor facility list',
      'California squash clubs list',
      'California badminton clubs list',
      'indoor padel clubs California',
      'best indoor pickleball courts Southern California',
      'best indoor pickleball courts Northern California',
      'sportsplex California',
      'California YMCA gymnasium court rental',
      'California multi-location indoor sports facility operator',
      'indoor basketball facility California list',
      'California futsal facilities indoor',
    ],
  },
  FL: {
    code: 'FL',
    name: 'Florida',
    stateRe: /(?:FL|Florida|Fla\.?)/,
    // Florida ZIPs run 32000-34999.
    zipRe: /\b(?:FL|Florida)\s+3[234]\d{3}\b/,
    zipBare: /^3[234]\d{3}$/,
    areaCodes:
      /\(?(239|305|321|352|386|407|448|561|656|689|727|754|772|786|813|850|863|904|941|954)\)?[)\s.-]{1,3}\d{3}[\s.-]?\d{4}/,
    mentionRe: /\b(?:South|Central|North) Florida\b|\bFlorida\b/i,
    markets: FL_MARKETS,
    places: placeSet(FL_MARKETS, [
      'south miami', 'north miami', 'north miami beach', 'miami lakes', 'miami gardens',
      'coconut grove', 'brickell', 'pinecrest', 'palmetto bay', 'cutler bay', 'sunny isles beach',
      'key biscayne', 'bal harbour', 'surfside', 'opa locka', 'hialeah gardens',
      'deerfield beach', 'pompano beach', 'oakland park', 'wilton manors', 'lauderhill',
      'tamarac', 'margate', 'coconut creek', 'parkland', 'cooper city', 'southwest ranches',
      'lake worth', 'greenacres', 'royal palm beach', 'palm beach', 'north palm beach',
      'tequesta', 'jensen beach', 'hobe sound', 'fort pierce', 'sebastian',
      'marco island', 'immokalee', 'lehigh acres', 'north fort myers', 'fort myers beach',
      'north port', 'englewood', 'nokomis', 'osprey', 'palmetto', 'ellenton', 'parrish',
      'safety harbor', 'oldsmar', 'seminole', 'pinellas park', 'st pete beach', 'tarpon springs',
      'new port richey', 'port richey', 'trinity', 'land o lakes', 'zephyrhills', 'valrico',
      'maitland', 'longwood', 'casselberry', 'winter springs', 'st cloud', 'davenport',
      'windermere', 'dr phillips', 'lake nona', 'mount dora', 'eustis', 'tavares',
      'neptune beach', 'atlantic beach', 'middleburg', 'green cove springs', 'nocatee',
      'port orange', 'new smyrna beach', 'deland', 'deltona', 'edgewater', 'flagler beach',
      'indialantic', 'satellite beach', 'rockledge', 'cape canaveral', 'alachua', 'newberry',
      'navarre', 'gulf breeze', 'milton', 'pace', 'panama city beach', 'marianna',
      'bartow', 'auburndale', 'haines city', 'lake wales', 'avon park', 'okeechobee',
      'islamorada', 'key largo',
    ]),
    gov: GOV('FL'),
    statewide: [
      'indoor pickleball facilities Florida directory',
      'USTA Florida indoor tennis facilities',
      'indoor sports complex Florida list',
      'Florida volleyball clubs indoor facility list',
      'indoor padel clubs Florida',
      'best indoor pickleball courts Florida',
      'sportsplex Florida',
      'Florida YMCA gymnasium court rental',
    ],
  },
  TN: {
    code: 'TN',
    name: 'Tennessee',
    stateRe: /(?:TN|Tennessee|Tenn\.?)/,
    // Tennessee ZIPs run 37000-38599.
    zipRe: /\b(?:TN|Tennessee)\s+3[78]\d{3}\b/,
    zipBare: /^3[78]\d{3}$/,
    areaCodes: /\(?(423|615|629|731|865|901|931)\)?[)\s.-]{1,3}\d{3}[\s.-]?\d{4}/,
    mentionRe: /\b(?:East|Middle|West) Tennessee\b|\bTennessee\b/i,
    markets: TN_MARKETS,
    places: placeSet(TN_MARKETS, [
      'antioch', 'bellevue', 'donelson', 'hermitage', 'madison', 'goodlettsville',
      'green hills', 'belle meade', 'berry hill', 'thompsons station', 'arrington',
      'fairview', 'ashland city', 'pleasant view', 'portland', 'la vergne',
      'oakland', 'lakeland', 'somerville', 'covington', 'brownsville',
      'powell', 'halls', 'karns', 'hardin valley', 'louisville', 'friendsville',
      'seymour', 'dandridge', 'newport', 'rogersville', 'church hill', 'jonesborough',
      'red bank', 'soddy daisy', 'collegedale', 'apison', 'lookout mountain',
      'algood', 'baxter', 'monterey', 'smithville', 'woodbury', 'lynchburg',
      'tellico village', 'loudon', 'clinton', 'norris', 'jacksboro',
    ]),
    gov: GOV('TN'),
    statewide: [
      'indoor pickleball facilities Tennessee directory',
      'USTA Southern indoor tennis facilities Tennessee',
      'indoor sports complex Tennessee list',
      'Tennessee volleyball clubs indoor facility list',
      'best indoor pickleball courts Tennessee',
      'sportsplex Tennessee',
      'Tennessee YMCA gymnasium court rental',
    ],
  },
};

export function stateConfig(code) {
  const s = STATES[String(code || '').toUpperCase()];
  if (!s) throw new Error(`Unknown state "${code}". Add it to src/states.js.`);
  return s;
}

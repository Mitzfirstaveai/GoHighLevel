// Organization content shown on the public pages (About, Committee, Sponsors, Contact).
// Taken from the Gujarati Samaj of Arkansas website; edit here to update.

const ORG = {
  shortName: 'GSA',
  motto: 'Together, We Serve Better',
  motto_gu: 'સાથે મળીને, વધુ સારી સેવા',
  founded: 1989,
  address: ['1 GSA Circle', 'Little Rock, Arkansas 72209'],
  phone: '(501) 916-2416',
  email: 'gsaarkansas@gmail.com',
  venue: 'GSA Community Center | 1 GSA Circle, Little Rock, AR 72209',
  ein: '', // shown on donation receipts when set
};

const ABOUT = {
  history: [
    'The Gujarati Samaj of Arkansas (GSA) was founded in 1989 by 35 Gujarati families who came together with a shared vision of preserving their cultural and religious heritage while building a strong community in Arkansas. Over the years, GSA has grown steadily and now represents more than 300 families, reflecting the strength, unity, and continued growth of the Gujarati community in the region.',
    'GSA is a nonprofit, charitable organization established to serve individuals and families of Gujarati heritage residing in the United States. The term Gujarati refers to individuals who are natives of, descendants of, or whose cultural roots originate in the state of Gujarat, India. GSA is dedicated to the preservation, promotion, and celebration of Gujarati culture, art, language, literature, and the Gujarati Hindu religious tradition. The organization also strives to foster friendship, mutual respect, and understanding among people of all ethnic, national, and religious backgrounds.',
  ],
  mission: 'The mission of the Gujarati Samaj of Arkansas is to honor and celebrate Gujarati heritage, culture, language, and the Gujarati Hindu religious tradition while nurturing a strong, united community for present and future generations. Guided by our motto, “Together, We Serve Better,” GSA brings individuals and families together in a spirit of service, cultural pride, and shared responsibility. Through the celebration of traditions, religious festivals such as Diwali and Navratri, and meaningful community milestones, GSA strengthens cultural identity and inspires the passing on of timeless moral values—love, honesty, respect, hard work, and faith. By creating opportunities for connection, learning, and service, GSA empowers younger generations to embrace their heritage, honor their ancestors’ journeys, and live lives rooted in integrity and purpose.',
  vision: 'The vision of the Gujarati Samaj of Arkansas is to be a vibrant, inclusive, and enduring community that strengthens unity and pride in Gujarati identity across generations. GSA envisions a future where cultural traditions, faith, and moral values are not only preserved but actively lived and shared, inspiring harmony, compassion, and mutual respect within the community and beyond.',
  nonprofit: 'GSA is organized and operated exclusively for charitable, educational, cultural, and religious purposes and qualifies as a tax-exempt organization under Section 501(c)(3) of the Internal Revenue Code. The organization does not engage in political activities, including lobbying, campaigning, or endorsing candidates for public office. Grants are awarded only to recognized tax-exempt organizations that align with GSA’s mission.',
  membership: 'Membership in GSA is open to individuals and families of integrity and good moral character who support the objectives of the Samaj and have roots in Gujarat, India.',
};

// Gujarati version of the About page, shown to members reading in Gujarati.
// (Please have a committee member review the wording.)
const ABOUT_GU = {
  history: [
    'ગુજરાતી સમાજ ઓફ અરકાન્સાસ (GSA)ની સ્થાપના 1989માં 35 ગુજરાતી પરિવારોએ કરી હતી, જેઓ પોતાના સાંસ્કૃતિક અને ધાર્મિક વારસાને જાળવી રાખવા તથા અરકાન્સાસમાં એક મજબૂત સમુદાય બનાવવાના સમાન સ્વપ્ન સાથે એકઠા થયા હતા. વર્ષોથી GSA સતત વિકસતું રહ્યું છે અને આજે 300થી વધુ પરિવારોનું પ્રતિનિધિત્વ કરે છે, જે આ પ્રદેશમાં ગુજરાતી સમુદાયની શક્તિ, એકતા અને સતત પ્રગતિ દર્શાવે છે.',
    'GSA એક બિનનફાકારક, સખાવતી સંસ્થા છે, જે અમેરિકામાં વસતા ગુજરાતી વારસાના વ્યક્તિઓ અને પરિવારોની સેવા માટે સ્થાપવામાં આવી છે. "ગુજરાતી" એટલે એવી વ્યક્તિઓ કે જેઓ ગુજરાત, ભારતના વતની છે, તેમના વંશજ છે અથવા જેમના સાંસ્કૃતિક મૂળ ગુજરાતમાં છે. GSA ગુજરાતી સંસ્કૃતિ, કળા, ભાષા, સાહિત્ય અને ગુજરાતી હિંદુ ધાર્મિક પરંપરાના જતન, પ્રોત્સાહન અને ઉજવણી માટે સમર્પિત છે. સંસ્થા તમામ જાતિ, રાષ્ટ્રીયતા અને ધર્મના લોકો વચ્ચે મિત્રતા, પરસ્પર આદર અને સમજણ વધારવાનો પણ પ્રયાસ કરે છે.',
  ],
  mission: 'ગુજરાતી સમાજ ઓફ અરકાન્સાસનું ધ્યેય ગુજરાતી વારસો, સંસ્કૃતિ, ભાષા અને ગુજરાતી હિંદુ ધાર્મિક પરંપરાનું સન્માન અને ઉજવણી કરવાનું છે, તેમજ વર્તમાન અને ભાવિ પેઢીઓ માટે એક મજબૂત, સંગઠિત સમુદાયનું ઘડતર કરવાનું છે. અમારા સૂત્ર "સાથે મળીને, વધુ સારી સેવા"ના માર્ગદર્શન હેઠળ GSA વ્યક્તિઓ અને પરિવારોને સેવા, સાંસ્કૃતિક ગૌરવ અને સહિયારી જવાબદારીની ભાવનાથી એકઠા કરે છે. પરંપરાઓ, દિવાળી અને નવરાત્રી જેવા ધાર્મિક તહેવારો તથા સમુદાયના મહત્વના પ્રસંગોની ઉજવણી દ્વારા GSA સાંસ્કૃતિક ઓળખને મજબૂત બનાવે છે અને પ્રેમ, પ્રામાણિકતા, આદર, પરિશ્રમ અને શ્રદ્ધા જેવા શાશ્વત નૈતિક મૂલ્યો આગળ વધારવાની પ્રેરણા આપે છે. જોડાણ, શિક્ષણ અને સેવાની તકો ઊભી કરીને GSA યુવા પેઢીને પોતાનો વારસો અપનાવવા, પૂર્વજોની યાત્રાનું સન્માન કરવા અને પ્રામાણિકતા તથા હેતુપૂર્ણ જીવન જીવવા સક્ષમ બનાવે છે.',
  vision: 'ગુજરાતી સમાજ ઓફ અરકાન્સાસનું સ્વપ્ન એક જીવંત, સર્વસમાવેશક અને ટકાઉ સમુદાય બનવાનું છે, જે પેઢી દર પેઢી ગુજરાતી ઓળખમાં એકતા અને ગૌરવને મજબૂત બનાવે. GSA એવા ભવિષ્યની કલ્પના કરે છે જ્યાં સાંસ્કૃતિક પરંપરાઓ, શ્રદ્ધા અને નૈતિક મૂલ્યો માત્ર જળવાય જ નહીં પરંતુ સક્રિય રીતે જીવાય અને વહેંચાય, અને સમુદાયમાં તથા તેની બહાર સુમેળ, કરુણા અને પરસ્પર આદરની પ્રેરણા આપે.',
  nonprofit: 'GSA સંપૂર્ણપણે સખાવતી, શૈક્ષણિક, સાંસ્કૃતિક અને ધાર્મિક હેતુઓ માટે સંગઠિત અને સંચાલિત છે અને ઇન્ટરનલ રેવન્યુ કોડની કલમ 501(c)(3) હેઠળ કરમુક્ત સંસ્થા તરીકે માન્ય છે. સંસ્થા લોબીંગ, ચૂંટણી પ્રચાર અથવા જાહેર હોદ્દા માટેના ઉમેદવારોને સમર્થન સહિતની કોઈ રાજકીય પ્રવૃત્તિઓમાં ભાગ લેતી નથી. અનુદાન ફક્ત GSAના ધ્યેય સાથે સુસંગત માન્ય કરમુક્ત સંસ્થાઓને જ આપવામાં આવે છે.',
  membership: 'GSAનું સભ્યપદ પ્રામાણિક અને સારા નૈતિક ચારિત્ર્ય ધરાવતા એવા વ્યક્તિઓ અને પરિવારો માટે ખુલ્લું છે, જેઓ સમાજના ઉદ્દેશોને ટેકો આપે છે અને જેમના મૂળ ગુજરાત, ભારતમાં છે.',
};

// [name, role, city, native village]
const COMMITTEE = [
  {
    title: 'Board of Trustees',
    members: [
      ['Kate Makan', 'Chairwoman', 'Little Rock', 'Sevni'],
      ['Chintu (Danny) Magan', 'Vice Chair', 'Conway', 'Kumbhariya'],
      ['Umang Patel', 'Secretary', 'N. Little Rock', 'Nizar'],
      ['Rocky Govind', 'Treasurer', 'Little Rock', 'Ruva'],
      ['Andy Patidar', 'Joint Treasurer', 'Little Rock', 'Dungar'],
      ['Jayesh Lallu', '', 'Cabot', 'Ambheti'],
      ['Andy Patel', '', 'Little Rock', 'Bardoli'],
      ['Naran Desai', '', 'N. Little Rock', 'Kharvasa'],
      ['Shawn Govind', '', 'Little Rock', 'Ruva'],
    ],
  },
  {
    title: 'Executive Committee',
    members: [
      ['Anil Patel', 'President', 'Little Rock', 'Bahumara'],
      ['Bimal Patel', 'Vice President', 'Sherwood', 'Siyod'],
      ['Raju Patel', 'Treasurer', 'Conway', 'Nagod'],
      ['Nilesh Patel', 'Joint Treasurer', 'Cabot', 'Barasadi'],
      ['Nimesh (Nemo) Patel', 'Secretary', 'Bryant', 'Adada'],
      ['Nayan Patel', 'Joint Secretary', 'Maumelle', 'Ruva-Bharampur'],
    ],
  },
  {
    title: 'Sub Committee',
    members: [
      ['Ajay Patel', '', 'Maumelle', 'Vyara'],
      ['Amrat Patel', '', 'Little Rock', 'Sevni'],
      ['Ashok Desai', '', 'Little Rock', 'Bardoli'],
      ['Bharat Patel', '', 'Maumelle', 'Siyod'],
      ['Darshan (DK) Patel', '', 'Conway', 'Kumbhariya'],
      ['Dhiru Patel', '', 'N. Little Rock', 'Dungar-Chikli'],
      ['Hemang Patel', '', 'Pine Bluff', 'Siyod'],
      ['Jaimin Patel', '', 'Sherwood', 'Sandha'],
      ['Jatin Patel', '', 'Benton', 'Afva'],
    ],
  },
];

const SPONSORS = [
  { tier: 'Platinum', names: ['Stone Bank', 'PremSupply — Your Premier HVAC Solutions Provider', 'Ecolab', 'Lumber One Home Center', 'Central Laundry Equipment'] },
];

// Gujarat & India news: stories mentioning any of these are never shown to members. Matching ignores case; words in
// lower case also catch longer forms ("vote" hides "voters"), names written with a capital letter match whole words.
// The committee edits this list in the admin area.
// It keeps the feed to non-political, uplifting reading that suits a 501(c)(3) community organization.
const NEWS_FILTER = [
  // US politics
  'Trump', 'Biden', 'Kamala Harris', 'Obama', 'JD Vance', 'White House', 'Republican', 'Democrat', 'GOP', 'MAGA',
  'Capitol Hill', 'US Senate', 'U.S. Senate',
  'ટ્રમ્પ', 'બાઇડન', 'બાઈડન', 'વ્હાઇટ હાઉસ', 'રિપબ્લિકન', 'ડેમોક્રેટ',
  // Elections, campaigns and political parties (a 501(c)(3) must stay out of campaigns)
  'election', 'electoral', 'exit poll', 'opinion poll', 'bypoll', 'by-poll', 'polling booth', 'vote', 'voting', 'voter',
  'candidate', 'campaign', 'manifesto', 'BJP', 'Congress', 'congressional', 'AAP', 'Aam Aadmi', 'Lok Sabha', 'Vidhan Sabha',
  'ચૂંટણી', 'મતદાન', 'મતદાર', 'ઉમેદવાર', 'ભાજપ', 'કોંગ્રેસ', 'આમ આદમી',
  // Distressing stories
  'murder', 'rape', 'suicide', 'killed', 'lynch', 'terror', 'riot', 'communal', 'massacre',
  'હત્યા', 'બળાત્કાર', 'આત્મહત્યા', 'આતંક', 'રમખાણ',
];

module.exports = { ORG, ABOUT, ABOUT_GU, COMMITTEE, SPONSORS, NEWS_FILTER };

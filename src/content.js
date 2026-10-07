// Organization content shown on the public pages (About, Committee, Sponsors, Contact).
// Taken from the Gujarati Samaj of Arkansas website; edit here to update.

const ORG = {
  shortName: 'GSA',
  motto: 'Together, We Serve Better',
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

module.exports = { ORG, ABOUT, COMMITTEE, SPONSORS };

import type { CourseProfileDraft, CourseProfileSourceDraft, CourseProfileTypeValue } from "@/lib/course-profiles/validation";

const verifiedAt = "2026-07-15T12:00:00.000Z";

type Seed = Omit<CourseProfileDraft, "courseId"> & { googlePlaceId: string };

function source(
  url: string,
  title: string,
  publisher: string,
  sourceType: CourseProfileSourceDraft["sourceType"],
  claimKeys = [
    "access",
    "course_type",
    "overview",
    "course_character",
    "notable_fact_0",
    "notable_fact_1"
  ]
): CourseProfileSourceDraft {
  return {
    url,
    title,
    publisher,
    sourceType,
    claimKeys,
    evidenceSummary: `${publisher}'s ${title} page supports these profile claims: ${claimKeys.map((claim) => claim.replaceAll("_", " ")).join(", ")}.`,
    accessedAt: verifiedAt
  };
}

function profile(input: {
  googlePlaceId: string;
  officialWebsiteUrl: string;
  city: string;
  county: string;
  courseType: CourseProfileTypeValue;
  accessSummary: string;
  overview: string;
  courseCharacter: string;
  notableFacts?: string[];
  sources: CourseProfileSourceDraft[];
}): Seed {
  const notableFactCount = input.notableFacts?.length ?? 0;
  const sources = input.sources.map((profileSource) => {
    const claimKeys = profileSource.claimKeys.filter((claimKey) => {
      if (!claimKey.startsWith("notable_fact_")) return true;
      const factIndex = Number.parseInt(claimKey.slice("notable_fact_".length), 10);
      return Number.isInteger(factIndex) && factIndex < notableFactCount;
    });

    return {
      ...profileSource,
      claimKeys,
      evidenceSummary: `${profileSource.publisher}'s ${profileSource.title} page supports these profile claims: ${claimKeys.map((claim) => claim.replaceAll("_", " ")).join(", ")}.`
    };
  });

  return {
    googlePlaceId: input.googlePlaceId,
    officialWebsiteUrl: input.officialWebsiteUrl,
    location: {
      city: input.city,
      stateCode: "CT",
      stateName: "Connecticut",
      county: input.county,
      countryCode: "US"
    },
    courseType: input.courseType,
    accessSummary: input.accessSummary,
    overview: input.overview,
    courseCharacter: input.courseCharacter,
    notableFacts: input.notableFacts ?? [],
    sources,
    profileVerifiedAt: verifiedAt
  };
}

export const connecticutCourseProfileSeeds: Seed[] = [
  profile({
    googlePlaceId: "ChIJW9hAyBHX54kRJXkG-UhbzbQ",
    officialWebsiteUrl: "https://www.allinggolfclub.com/",
    city: "New Haven",
    county: "New Haven",
    courseType: "MUNICIPAL",
    accessSummary: "A public municipal golf course operated for the City of New Haven with resident and non-resident play.",
    overview: "Alling Golf Club is New Haven’s municipal course, positioned a short drive from downtown and managed as a public daily-play facility.",
    courseCharacter: "The eighteen-hole layout is presented as an approachable but testing round, with enough variety to serve regular play, instruction, and group outings.",
    notableFacts: ["New Haven contracts for the operation and maintenance of Alling Memorial Golf Course.", "The course offers separate resident rates for New Haven and East Haven golfers."],
    sources: [
      source("https://www.allinggolfclub.com/", "Alling Memorial Golf Club", "Alling Memorial Golf Club", "OFFICIAL_COURSE", ["access", "course_type"]),
      source("https://newenglandgolfcorp.com/-about", "About New England Golf Corporation", "New England Golf Corporation", "OFFICIAL_OPERATOR"),
      source("https://newhaven-ct.legistar.com/LegislationDetail.aspx?From=RSS&GUID=437A3719-FD0E-4F20-B792-FCAE704DC4D9&ID=6835255", "Alling Memorial operating agreement", "City of New Haven", "MUNICIPAL_GOVERNMENT", ["access", "course_type"])
    ]
  }),
  profile({
    googlePlaceId: "ChIJ8ffRbkMR5okRBH1bq32atz4",
    officialWebsiteUrl: "https://www.cedarridgegolfcourse.com/",
    city: "East Lyme",
    county: "New London",
    courseType: "DAILY_FEE",
    accessSummary: "A public eighteen-hole executive course in East Lyme that accepts online tee times.",
    overview: "Cedar Ridge is an eighteen-hole executive course near Interstate 95 in East Lyme, built around a shorter par-three-oriented round.",
    courseCharacter: "Its compact routing is intended to fit a round into roughly a few hours while still asking experienced golfers to control distance and direction on longer par threes.",
    notableFacts: ["The official site describes the course as an eighteen-hole par-three facility."],
    sources: [source("https://www.cedarridgegolfcourse.com/about", "About Cedar Ridge Golf Course", "Cedar Ridge Golf Course", "OFFICIAL_COURSE")]
  }),
  profile({
    googlePlaceId: "ChIJZ3Rrpzzi54kR_g0Sly9n8Bc",
    officialWebsiteUrl: "https://www.whitneyfarmsgc.com/",
    city: "Monroe",
    county: "Fairfield",
    courseType: "DAILY_FEE",
    accessSummary: "A family-operated, public eighteen-hole course in Monroe with daily tee-time access and optional memberships.",
    overview: "Chris Bargas Golf Club at Whitney Farms is a Hal C. Purdy design that opened in 1982 on land formerly used by the Whitney family for farming.",
    courseCharacter: "The full-length course combines broad fairways, ponds, rolling Connecticut scenery, and greens that reward thoughtful approach play across several tee choices.",
    notableFacts: ["The property was renamed in 2024 to honor founder Chris Bargas Sr.", "Walkers are welcome, and the facility also offers a driving range and practice green."],
    sources: [source("https://www.whitneyfarmsgc.com/", "Chris Bargas Golf Club at Whitney Farms", "Chris Bargas Golf Club", "OFFICIAL_COURSE")]
  }),
  profile({
    googlePlaceId: "ChIJzeO7wBcP6IkR_XvZ7JAT5X8",
    officialWebsiteUrl: "https://www.fairchildwheelergolf.com/",
    city: "Fairfield",
    county: "Fairfield",
    courseType: "MUNICIPAL",
    accessSummary: "A public municipal golf facility serving Fairfield and Bridgeport-area golfers with two separate eighteen-hole courses.",
    overview: "Fairchild Wheeler offers Red and Black eighteen-hole courses from one public facility on Easton Turnpike in Fairfield.",
    courseCharacter: "The Red course emphasizes accurate tee shots and demanding green reading, while the Black course uses winding hills, scenic corridors, and renovated bunkering for a different test.",
    notableFacts: ["The facility includes a driving range and hosts youth instruction programs."],
    sources: [source("https://www.fairchildwheelergolf.com/home/", "Fairchild Wheeler Golf Course", "Fairchild Wheeler Golf Course", "OFFICIAL_COURSE")]
  }),
  profile({
    googlePlaceId: "ChIJ-ShxHDsi5okR1EPXKbMwfk8",
    officialWebsiteUrl: "https://www.fenwickgolfcourse.com/",
    city: "Old Saybrook",
    county: "Middlesex",
    courseType: "MUNICIPAL",
    accessSummary: "A public, daily-fee nine-hole course operated in the Borough of Fenwick, with some seasonal access restrictions.",
    overview: "Fenwick Golf Course opened in 1896 where the Connecticut River meets Long Island Sound and remains a compact public coastal course.",
    courseCharacter: "The flat, walkable routing has an old-style links character shaped by small greens, open water views, and changing coastal wind rather than sheer length.",
    notableFacts: ["Fenwick identifies itself as Connecticut’s oldest public golf course.", "The facility also has a five-hole Ryder Cup course with separate seasonal rules."],
    sources: [source("https://www.fenwickgolfcourse.com/", "Fenwick Golf Course", "Fenwick Golf Course", "OFFICIAL_COURSE")]
  }),
  profile({
    googlePlaceId: "ChIJczYliudS5okRfLJzTdhPkYE",
    officialWebsiteUrl: "https://www.goodwinparkgolfcourse.com/",
    city: "Hartford",
    county: "Hartford",
    courseType: "MUNICIPAL",
    accessSummary: "A City of Hartford public golf facility with an eighteen-hole South Course and a nine-hole North Course.",
    overview: "Goodwin Park combines two public layouts, practice facilities, and a driving range at the city park on Maple Avenue.",
    courseCharacter: "The par-70 South Course asks golfers to control ball flight and choose risk carefully, while the shorter North Course provides another way to play the property.",
    notableFacts: ["Hartford and Wethersfield residents can qualify for resident rates.", "The official policy says tee times are generally available seven days ahead."],
    sources: [source("https://www.goodwinparkgolfcourse.com/index.php", "Goodwin Park Golf Course", "Goodwin Park Golf Course", "OFFICIAL_COURSE")]
  }),
  profile({
    googlePlaceId: "demo-smith-richardson",
    officialWebsiteUrl: "https://hsrgolf.com/",
    city: "Fairfield",
    county: "Fairfield",
    courseType: "MUNICIPAL",
    accessSummary: "The Town of Fairfield’s public eighteen-hole championship course, with resident and non-resident access.",
    overview: "H. Smith Richardson is Fairfield’s full-length municipal course, offering eighteen distinct holes across rolling terrain on Morehouse Highway.",
    courseCharacter: "The layout moves uphill and downhill through straight and dogleg holes, with wind exposure and large, undulating greens adding much of the challenge.",
    notableFacts: ["Several tee sets span roughly 5,300 to 6,700 yards.", "The Town of Fairfield also operates the separate Carl Dickman Par 3 course."],
    sources: [source("https://hsrgolf.com/", "H. Smith Richardson Golf Course", "Town of Fairfield Golf Courses", "MUNICIPAL_GOVERNMENT")]
  }),
  profile({
    googlePlaceId: "ChIJP_ngIIa154kReyDUULyEPTE",
    officialWebsiteUrl: "https://www.huntergolfclub.com/",
    city: "Meriden",
    county: "New Haven",
    courseType: "MUNICIPAL",
    accessSummary: "Meriden’s public municipal eighteen-hole course, open for daily play and city golf programs.",
    overview: "Hunter Golf Club began as Meriden Municipal Golf Course in 1929, expanded to eighteen holes in 1935, and later took the name of longtime professional George Hunter.",
    courseCharacter: "The modern routing reflects a substantial late-1980s redesign and uses the site’s elevation to frame views toward nearby trap-rock ridges and Castle Craig.",
    notableFacts: ["The course retains visible traces of several earlier greens and routing changes.", "Hunter has hosted state and New England public-links events."],
    sources: [source("https://www.huntergolfclub.com/history", "Hunter Golf Club history", "Hunter Golf Club", "OFFICIAL_COURSE")]
  }),
  profile({
    googlePlaceId: "ChIJr0Jtm-0b6IkRTZRbjZgl6Fs",
    officialWebsiteUrl: "https://www.westportct.gov/government/departments-a-z/parks-and-recreation/longshore-club-park/longshore-golf-course",
    city: "Westport",
    county: "Fairfield",
    courseType: "MUNICIPAL",
    accessSummary: "A Town of Westport public eighteen-hole course with resident and guest booking rules.",
    overview: "Longshore Club Park Golf Course is a compact eighteen-hole municipal layout overlooking Long Island Sound in Westport.",
    courseCharacter: "The course’s modest overall length is balanced by small, well-bunkered greens and a coastal setting where wind can influence club selection.",
    notableFacts: ["The Town of Westport operates the course.", "Resident handpass holders and guests follow different advance-booking windows."],
    sources: [source("https://www.westportct.gov/government/departments-a-z/parks-and-recreation/longshore-club-park/longshore-golf-course", "Longshore Golf Course", "Town of Westport", "MUNICIPAL_GOVERNMENT")]
  }),
  profile({
    googlePlaceId: "ChIJi738K6BQ5okRhETtu_caJxU",
    officialWebsiteUrl: "https://www.minnechauggolf.com/",
    city: "Glastonbury",
    county: "Hartford",
    courseType: "MUNICIPAL",
    accessSummary: "A public nine-hole course in East Glastonbury with online tee-time access.",
    overview: "Minnechaug is a compact public layout at the base of Minnechaug Mountain, offering nine holes for a par in the mid-thirties.",
    courseCharacter: "Water defines the finish, most notably the short eighth hole’s island green and the pond carry presented from the elevated ninth tee.",
    notableFacts: ["The Town of Glastonbury lists Minnechaug as a public golf facility.", "The eighth hole is identified by the course as an early New England island green."],
    sources: [source("https://www.minnechauggolf.com/", "Minnechaug Golf Course", "Minnechaug Golf Course", "OFFICIAL_COURSE")]
  }),
  profile({
    googlePlaceId: "ChIJwxdZ2uAd6IkRI63osFcqwqY",
    officialWebsiteUrl: "https://www.oakhillsgc.com/",
    city: "Norwalk",
    county: "Fairfield",
    courseType: "MUNICIPAL",
    accessSummary: "A public eighteen-hole course overseen by the Oak Hills Park Authority for Norwalk residents and visiting golfers.",
    overview: "Oak Hills Park centers an eighteen-hole public course within 144 acres of rolling, wooded parkland in West Norwalk.",
    courseCharacter: "The Alfred Tull design mixes naturally shaped holes and varied shots across a par-71 routing, with several tee and pass options for public play.",
    notableFacts: ["The Oak Hills Park Authority has managed daily operations since 1998.", "Walking trails and tennis share the wider park property."],
    sources: [source("https://www.oakhillsgc.com/welcome-to-oak-hills-park-golf-club", "Welcome to Oak Hills Park Golf Club", "Oak Hills Park Authority", "MUNICIPAL_GOVERNMENT")]
  }),
  profile({
    googlePlaceId: "ChIJzSJLBAN16IkRRASQvZPAIPQ",
    officialWebsiteUrl: "https://orchardsgc.com/",
    city: "Milford",
    county: "New Haven",
    courseType: "DAILY_FEE",
    accessSummary: "A public, community-oriented nine-hole daily-fee course in Milford with online and phone reservations.",
    overview: "The Orchards is a nine-hole Milford course managed by Northeast Golf Company as a gathering place for local players, families, and leagues.",
    courseCharacter: "Its shorter routing is positioned as an affordable, relaxed round for varied ability levels, supported by a traditional pro shop and public tee sheet.",
    notableFacts: ["The course uses ForeUP for online reservations.", "The operator also accepts tee-time requests by phone."],
    sources: [source("https://orchardsgc.com/", "Orchards Golf Course", "Orchards Golf Course", "OFFICIAL_COURSE")]
  }),
  profile({
    googlePlaceId: "ChIJCaCWSQvv54kRcgxxK-Ry4Qc",
    officialWebsiteUrl: "https://www.pomperauggolfct.com/",
    city: "Southbury",
    county: "New Haven",
    courseType: "DAILY_FEE",
    accessSummary: "A public-access nine-hole daily-fee course in Southbury with online tee times, daily rates, and optional memberships.",
    overview: "Pomperaug Golf Club is a regulation nine-hole course in Southbury designed by Ted Manning and opened in 1973.",
    courseCharacter: "Multiple tee choices vary the playing distance, while water influences every hole and makes placement an important part of the compact round.",
    notableFacts: ["The course remains open year-round when weather and snow conditions permit.", "Its public practice options include a putting green and instruction programs."],
    sources: [source("https://www.pomperauggolfct.com/", "Pomperaug Golf Club", "Pomperaug Golf Club", "OFFICIAL_COURSE")]
  }),
  profile({
    googlePlaceId: "ChIJud9iakFJ5okRy95Uxgg88No",
    officialWebsiteUrl: "https://portlandgolfcourse.com/",
    city: "Portland",
    county: "Middlesex",
    courseType: "DAILY_FEE",
    accessSummary: "A family-owned public eighteen-hole course in Portland with daily tee-time access.",
    overview: "Portland Golf Course is a Geoffrey Cornish design set in the rolling hills of the Connecticut River Valley and operated by the Kelley family since 1974.",
    courseCharacter: "The routing uses elevation and varied hole directions to let golfers approach the course in several ways instead of relying on a single repeated shot shape.",
    notableFacts: ["The course has remained family owned and operated since opening in 1974."],
    sources: [source("https://portlandgolfcourse.com/", "Portland Golf Course", "Portland Golf Course", "OFFICIAL_COURSE")]
  }),
  profile({
    googlePlaceId: "ChIJ2X8k1kBJ5okR-i8C7nG_6Bs",
    officialWebsiteUrl: "https://www.quarryridge.com/",
    city: "Portland",
    county: "Middlesex",
    courseType: "DAILY_FEE",
    accessSummary: "A public eighteen-hole daily-fee course in Portland with online reservations and cart-inclusive in-season play.",
    overview: "Quarry Ridge crosses rolling hills and granite outcroppings above views toward Meshomasic State Forest and the Connecticut River.",
    courseCharacter: "The Al Zikorus and Joe Kelley design uses pronounced elevation changes and exposed rock to create an eighteen-hole round with a distinct central Connecticut setting.",
    notableFacts: ["The course opened with nine holes in 1993 and later expanded to eighteen.", "The official course policy describes in-season play as riding only."],
    sources: [
      source("https://www.quarryridge.com/", "Quarry Ridge Golf Course", "Quarry Ridge Golf Course", "OFFICIAL_COURSE", ["access", "course_type", "notable_fact_1"]),
      source("https://ctvisit.com/listings/quarry-ridge-golf-course", "Quarry Ridge Golf Course", "Connecticut Office of Tourism", "GOVERNMENT_TOURISM", ["overview", "course_character", "notable_fact_0"]),
      source("https://www.middletownpress.com/business/article/portland-ct-quarry-ridge-golf-course-21331055.php", "Quarry Ridge property and course", "The Middletown Press", "ESTABLISHED_NEWS", ["overview", "course_character", "notable_fact_0"])
    ]
  }),
  profile({
    googlePlaceId: "ChIJBaDAwElU3YkR9Aq2b1eaU9M",
    officialWebsiteUrl: "https://www.richterpark.com/",
    city: "Danbury",
    county: "Fairfield",
    courseType: "MUNICIPAL",
    accessSummary: "A City of Danbury public eighteen-hole course with resident and non-resident tee-time access.",
    overview: "Richter Park is an Edward Ryder-designed par-71 course developed by the City of Danbury around reservoirs, ponds, and hilly western Connecticut terrain.",
    courseCharacter: "Water can influence most of the round, with tree-lined approaches, elevated views, guarded greens, and a mix of blind or risk-reward decisions across both nines.",
    notableFacts: ["The course includes a public driving range and short-game practice areas.", "Resident identification provides access to a separate advance-booking window."],
    sources: [source("https://www.richterpark.com/course-tour/", "Richter Park course tour", "Richter Park Golf Course", "OFFICIAL_COURSE")]
  }),
  profile({
    googlePlaceId: "ChIJoydQZx8P5okRnIOpot2Ieqo",
    officialWebsiteUrl: "https://www.shennygolf.com/",
    city: "Groton",
    county: "New London",
    courseType: "MUNICIPAL",
    accessSummary: "A Town of Groton public eighteen-hole course operated through Parks and Recreation.",
    overview: "Shennecossett traces its history to 1898 and today combines a Donald Ross-influenced municipal layout with holes overlooking the Thames River and Long Island Sound.",
    courseCharacter: "The course blends classic routing, strategic green approaches, and a coastal finish where the sixteenth and seventeenth holes open toward broad waterfront views.",
    notableFacts: ["Donald Ross redesigned the layout in 1916 and refined portions in 1919.", "Groton has operated Shennecossett for public play since 1969."],
    sources: [source("https://www.shennygolf.com/about-us", "About Shennecossett Golf Course", "Town of Groton Parks and Recreation", "MUNICIPAL_GOVERNMENT")]
  }),
  profile({
    googlePlaceId: "ChIJYVcZNxQN6IkRs8x8563f2OU",
    officialWebsiteUrl: "https://www.stratfordct.gov/o/stratford/page/short-beach-golf-course",
    city: "Stratford",
    county: "Fairfield",
    courseType: "MUNICIPAL",
    accessSummary: "A seasonal Town of Stratford public par-three course with resident and non-resident rates.",
    overview: "Short Beach Golf Course is Stratford’s compact municipal course at the town’s multi-use waterfront recreation area on Dorne Drive.",
    courseCharacter: "The nine-hole par-three layout offers a shorter round shaped by ponds, bunkers, and views near the mouth of the Housatonic River.",
    notableFacts: ["The town supports online and pro-shop reservations.", "The official page says tee times may generally be reserved six days ahead."],
    sources: [source("https://www.stratfordct.gov/o/stratford/page/short-beach-golf-course", "Short Beach Golf Course", "Town of Stratford", "MUNICIPAL_GOVERNMENT")]
  }),
  profile({
    googlePlaceId: "ChIJz0N5vjz15okRaYlKRkRUSIQ",
    officialWebsiteUrl: "https://www.skungamauggolf.com/",
    city: "Coventry",
    county: "Tolland",
    courseType: "DAILY_FEE",
    accessSummary: "A public-access eighteen-hole course in Coventry offering daily tee times and optional memberships.",
    overview: "Skungamaug River Golf Club is a traditional eighteen-hole facility that grew from an original 1965 nine into its present layout in 1981.",
    courseCharacter: "At under six thousand yards from the back markers, the par-70 course emphasizes accuracy, shot selection, and use of the full bag more than raw distance.",
    notableFacts: ["Chet Jenkins designed the original nine, and John Motycka designed the second nine."],
    sources: [source("https://www.skungamauggolf.com/course/golf-course", "Skungamaug River golf course", "Skungamaug River Golf Club", "OFFICIAL_COURSE")]
  }),
  profile({
    googlePlaceId: "ChIJz4g2jXmy54kR1vbpETViooY",
    officialWebsiteUrl: "https://www.stanleygolfcourse.com/",
    city: "New Britain",
    county: "Hartford",
    courseType: "MUNICIPAL",
    accessSummary: "A public municipal twenty-seven-hole facility in New Britain with daily play and resident programs.",
    overview: "Stanley Municipal Golf Course provides twenty-seven public holes plus a covered, heated driving range close to central New Britain and Hartford-area highways.",
    courseCharacter: "Multiple nines give golfers different eighteen-hole combinations, while the range and teaching facilities support both practice sessions and full rounds.",
    notableFacts: ["The range uses Toptracer technology across nineteen covered bays.", "New Britain and Newington residents can qualify for resident benefits."],
    sources: [source("https://www.stanleygolfcourse.com/", "Stanley Municipal Golf Course", "Stanley Golf Course", "MUNICIPAL_GOVERNMENT")]
  }),
  profile({
    googlePlaceId: "demo-tashua-knolls",
    officialWebsiteUrl: "https://www.tashuaknolls.com/",
    city: "Trumbull",
    county: "Fairfield",
    courseType: "MUNICIPAL",
    accessSummary: "A Town of Trumbull public twenty-seven-hole facility with an eighteen-hole championship course and nine-hole companion course.",
    overview: "Tashua Knolls combines the original eighteen-hole Knolls layout with the adjacent nine-hole Tashua Glen on a self-funded municipal property in northern Trumbull.",
    courseCharacter: "The Knolls moves through rolling New England farmland, mature trees, old stone walls, bunkers, and water, while the Glen provides a shorter family-oriented routing with additional forward tees.",
    notableFacts: ["The Town of Trumbull owns the facility.", "The property includes a full driving range, short-game areas, and indoor training space."],
    sources: [source("https://www.tashuaknolls.com/golf-course/", "About Tashua Knolls", "Tashua Knolls Golf Course", "MUNICIPAL_GOVERNMENT")]
  }),
  profile({
    googlePlaceId: "ChIJExAgjx_f54kROzCYBnwhxwo",
    officialWebsiteUrl: "https://www.traditionatoaklane.com/",
    city: "Woodbridge",
    county: "New Haven",
    courseType: "DAILY_FEE",
    accessSummary: "A public daily-fee eighteen-hole course in Woodbridge designed to offer a private-club atmosphere without long-term membership.",
    overview: "The Tradition Golf Club at Oak Lane is a Geoffrey Cornish-designed public course that evolved from the former Oak Lane Country Club.",
    courseCharacter: "The par-72 routing pairs firm greens and strategic bunkering with a full-length layout intended to feel polished while remaining available through daily online booking.",
    notableFacts: ["The grass driving range is open to the public seasonally.", "The course completed Capillary Concrete bunker work in 2022."],
    sources: [source("https://www.traditionatoaklane.com/course", "The Tradition Golf Club course", "The Tradition Golf Club at Oak Lane", "OFFICIAL_COURSE")]
  }),
  profile({
    googlePlaceId: "ChIJxbUaKYfb54kR4Fmn5qg5lys",
    officialWebsiteUrl: "https://www.thevuect.com/",
    city: "Hamden",
    county: "New Haven",
    courseType: "DAILY_FEE",
    accessSummary: "A public-access eighteen-hole course in Hamden offering championship-style golf without a private-club commitment.",
    overview: "The VUE’s golf course is the former Laurel View Country Club, a Geoffrey Cornish design that opened in 1969 and now anchors a broader golf, dining, and event property.",
    courseCharacter: "Several tee positions make the long par-72 layout adjustable for different players, while rolling terrain and panoramic views define much of the experience.",
    notableFacts: ["The facility includes a Trackman-equipped driving range.", "The property was renovated and rebranded as The VUE beginning in 2021."],
    sources: [source("https://www.thevuect.com/golf", "Golf at The VUE", "The VUE", "OFFICIAL_COURSE")]
  }),
  profile({
    googlePlaceId: "ChIJdxeR34O254kR9sXtn4YwOh4",
    officialWebsiteUrl: "https://www.timberlingolf.com/",
    city: "Berlin",
    county: "Hartford",
    courseType: "MUNICIPAL",
    accessSummary: "Berlin’s public municipal eighteen-hole course, open to daily players, leagues, and membership programs.",
    overview: "Timberlin Golf Club is an Al Zikorus municipal design built in 1970 at the base of Ragged Mountain in Berlin.",
    courseCharacter: "The par-72 course uses rolling terrain and views across surrounding farmland to provide a full-length test that remains playable for newer golfers from forward tees.",
    notableFacts: ["The facility has hosted state championships and USGA qualifying events.", "Timberlin supports junior, women’s, senior, and men’s golf programs."],
    sources: [source("https://www.timberlingolf.com/", "Timberlin Golf Club", "Timberlin Golf Course", "MUNICIPAL_GOVERNMENT")]
  }),
  profile({
    googlePlaceId: "ChIJkwlAz0345okRHWJaEX8yIMs",
    officialWebsiteUrl: "https://topstonegc.com/",
    city: "South Windsor",
    county: "Hartford",
    courseType: "DAILY_FEE",
    accessSummary: "A public eighteen-hole daily-fee course in South Windsor with online tee times, leagues, and outings.",
    overview: "Topstone Golf Course opened in 1997 as a par-72 championship-style public layout on Griffin Road in South Windsor.",
    courseCharacter: "The routing moves across rolling hills and broad green corridors, pairing a full eighteen-hole round with an on-site golf shop, grill, and event facilities.",
    notableFacts: ["Topstone supports public leagues, junior golf, and group outings."],
    sources: [source("https://topstonegc.com/", "Topstone Golf Course", "Topstone Golf Course", "OFFICIAL_COURSE")]
  }),
  profile({
    googlePlaceId: "ChIJUypX_OHc54kRkpGKTvmSvSA",
    officialWebsiteUrl: "https://www.woodhavenctgolf.com/",
    city: "Bethany",
    county: "New Haven",
    courseType: "DAILY_FEE",
    accessSummary: "A family-owned and operated public nine-hole course in Bethany with online tee times.",
    overview: "Woodhaven is a compact nine-hole public course set in the wooded landscape around Miller Road in Bethany.",
    courseCharacter: "The small, independently operated property offers a straightforward local round with a forested setting and the option to reserve through its public booking page.",
    notableFacts: ["The course describes itself as family owned and operated."],
    sources: [source("https://www.woodhavenctgolf.com/", "Woodhaven", "Woodhaven Country Club", "OFFICIAL_COURSE")]
  })
];

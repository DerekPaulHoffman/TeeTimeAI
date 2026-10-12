export type PublicSimulatorFixtureKind = "TEESHEET" | "UPPER_HAND" | "YOUR_GOLF_BOOKING";

/** Controlled signed-out provider shapes. An unexpected request always fails;
 * this fixture has no network, customer transport or credential fallback. */
export function publicSimulatorFixture(kind: PublicSimulatorFixtureKind) {
  const providerUrl = kind === "TEESHEET" ? "https://fixturevenue.teesheet.ai/" : kind === "UPPER_HAND"
    ? "https://app.upperhand.io/customers/1683-fixture-venue/events"
    : "https://booking.trackmangolf.com/venues/fixture-venue/booking/bays";
  const eventUrl = "https://app.upperhand.io/customers/1683-fixture-venue/events/100948-virtual-golf-1-hour";
  const state = { venue: { id: 1543, slug: "fixture-venue", timezone: "UTC", status: "live", maintenanceMode: false },
    ranges: { items: [{ id: 1591, venue: 1543, slug: "bays", bookable: true, slotDuration: 30, slotInterval: 30, slotIntervalStart: 30, assumeOpen: true,
      bookingUi: "standard", customerBookingUi: "slots", maxBookAheadValue: 2, maxBookAheadUnit: "week", openingTimes: [],
      openingHours: ["Mo","Tu","We","Th","Fr","Sa","Su"].map(day => `${day} 09:00-18:00 open`).join(";") }] },
    bays: { items: [9939,9940,9941,9942,9943,9944].map(id => ({id,venue:1543,range:1591,type:"simulator",bookable:true,restrictedTimes:[],options:[23928],appliedOptions:[23928]})),
      bayOptions:[{id:23928,venue:1543,name:"Public Rate",adminOnly:false,type:"simulator",category:null,disabled:false,waitlisted:false,
        duration:1,durationType:"slot",minBookingDuration:2,maxBookingDuration:8,minPlayers:1,maxPlayers:4,bufferPeriodMinutes:0,restrictions:[],appliedRequiredPerks:[]}] } };
  const response = (value: unknown) => new Response(JSON.stringify(value), {headers:{"content-type":"application/json"}});
  const page = (body: string) => new Response(`<html><body>${body}</body></html>`,{headers:{"content-type":"text/html"}});
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (init?.method !== "GET" || init.credentials !== "omit") throw new Error("Fixture requires public GET only.");
    if (url.origin === "https://official.example.test" && url.pathname === "/") return page(`<a href="${providerUrl}">Book Now</a>`);
    if (url.href === providerUrl) return page(kind === "YOUR_GOLF_BOOKING"
      ? `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({props:{pageProps:{initialReduxState:state}}})}</script>` : "Public simulator calendar");
    if (kind === "TEESHEET" && url.origin === "https://qdp9jvb6p6.execute-api.us-east-1.amazonaws.com" && url.searchParams.get("venue") === "fixturevenue") {
      if (url.pathname === "/prod/availability/pricing") return response({booking_settings:{min_duration_mins:30,max_duration_mins:480,time_increment_mins:15,advance_booking_days:60}});
      if (url.pathname === "/prod/availability/slots") return response({date:url.searchParams.get("date"),duration_mins:60,priced_for:"me",request_mode:false,would_be_closed:false,
        slots:[{simulator_id:"3fb6ce8b-7df0-4d99-b032-25b41ccf773f",start_time:"10:00",end_time:"11:00",taken:false,is_training_bay:false}]});
    }
    if (kind === "UPPER_HAND" && url.origin === "https://api.upperhand.io" && new Headers(init.headers).get("X-Customer-Id") === "1683") {
      if (url.pathname === "/api/compound_objects/browse_events_list") return response({page:1,per_page:20,total_count:1,events:[{event_id:100948,event_title:"Virtual Golf - 1 Hour",duration:3600,schedule_type:"open_booking"}]});
      if (url.pathname === "/api/events/100948") return response({id:100948,url:eventUrl,privacy:false,status:"active",schedule_type:"open_booking",exclusive_membership_ids:[],exclusive_membership_tier_ids:[],
        schedules:[{event_id:100948,status:"standard",duration:3600,resource_usage_mode:"use_one",max_size:1,staff_member_ids:[],staff_admin_ids:[],resource_ids:[3859,3860]}]});
      if (url.pathname === "/api/events/100948/availability") return response({spots_remaining:0,available_times:[{date:url.searchParams.get("date"),start_time:"10:00:00",end_time:"11:00:00",spots_remaining:2,staff:[],resources:[{resource_id:3859,spots_remaining:1},{resource_id:3860,spots_remaining:1}]}]});
    }
    if (kind === "YOUR_GOLF_BOOKING" && url.origin === "https://api.yourgolfbooking.com" && url.pathname === "/venue/fixture-venue/bookings/public") {
      const date = url.searchParams.get("start_lte")!.slice(0,10);
      return response([{id:12345,status:"confirmed",type:"bay",bayId:9939,bayRef:"1",bayOptionId:28,rangeId:null,start:`${date}T10:00:00Z`,end:`${date}T11:00:00Z`}]);
    }
    throw new Error("Unexpected request in isolated public provider fixture.");
  };
  return {providerUrl,fetchImpl};
}

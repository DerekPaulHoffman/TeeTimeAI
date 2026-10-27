export const CUSTOMER_EMAIL_STATES = [
  "checking", "identity", "confirmed", "watching", "window", "expected", "retrying", "adding", "review",
  "direct", "phone", "account", "verification", "invalid", "recovered", "stale", "gone", "outside"
] as const;

export type CustomerEmailState = typeof CUSTOMER_EMAIL_STATES[number];

/** Facts and future ownership stay separate. Callers select states from durable results. */
export function getCustomerStatusCopy(state: CustomerEmailState, options: {
  simulator?: boolean;
  facts?: string;
} = {}) {
  const venue = options.simulator ? "venue" : "course";
  const times = options.simulator ? "sessions" : "tee times";
  const copies = {
    confirmed: ["WE’RE WATCHING", "Your alert is working", `Current ${times} were checked on the official booking page. Matching openings are included in your opening alert.`, "No action needed. We’ll email you when we find a new match.", false, "monitored"],
    checking: ["GETTING STARTED", `We’re checking this ${venue} for you`, "Your alert is saved. We haven’t confirmed any openings here yet.", "No action needed. We’ll email you when we confirm a matching opening.", false, "scheduled"],
    identity: ["CONFIRMING THE DETAILS", `We’re checking this ${venue} listing`, options.simulator ? "We need to confirm public simulator rentals before showing any sessions." : "We need to confirm that this is a public golf course before showing any tee times.", "We’ll check the venues that are ready while these details are confirmed.", false, "adding"],
    watching: ["WE’RE WATCHING", `We’re watching for your ${options.simulator ? "session" : "tee time"}`, options.facts || `We checked this ${venue} and found no ${times} matching your saved request yet.`, "No action needed. We’ll keep looking and email you when we find a match.", false, "monitored"],
    window: ["WAITING FOR BOOKING TO OPEN", "Your requested date hasn’t opened yet", options.facts || `This ${venue} hasn’t released ${times} for your date yet.`, "No action needed. We’ll check when booking opens for your date.", false, "scheduled"],
    expected: ["TIMES EXPECTED LATER", "Your date’s openings may appear later", options.facts || "Recent releases suggest that openings for your date may appear later. This is an estimate, not a confirmed release schedule.", "No action needed. We’ll check again around the expected release and email you when we find a match.", false, "scheduled"],
    retrying: ["WE’RE CHECKING ON IT", "Your alert is still active", "We couldn’t confirm openings on our last check.", "We’ll check again automatically. You don’t need to do anything.", false, "retrying"],
    adding: ["WE’RE CHECKING THE SETUP", `We’re checking whether we can watch this ${venue}`, "Your alert is saved, but we haven’t confirmed that we can check this booking site yet.", "We’ll update you when this venue’s alert status changes. You can check the official site in the meantime.", false, "adding"],
    review: ["CHECK DIRECTLY FOR NOW", "This venue needs a closer look", `Automatic alerts aren’t ready for this ${venue}. We haven’t confirmed current openings here.`, "Check the official site for current openings. Your other selected venues are checked separately.", true, "direct"],
    direct: ["CHECK DIRECTLY", `Use this ${venue}’s official site`, options.facts || `Tee Time Spot can’t check ${times} here automatically.`, "Open the official site to see current options. Your other selected venues are checked separately.", true, "direct"],
    phone: ["CALL FOR OPENINGS", `Contact the ${venue} for current openings`, options.facts || `This ${venue} confirms availability directly, so we can’t watch for openings here.`, "Use the venue’s official contact details to ask about current openings.", true, "direct"],
    account: ["SIGN IN TO CHECK", `This ${venue} requires its own sign-in`, "Current openings are only visible after you sign in on its website. Tee Time Spot can’t check pages that require your account.", "Sign in yourself on the venue’s official site to see current openings.", true, "direct"],
    verification: ["CHECK DIRECTLY", "The booking site needs you to take a step", "Its verification step or waiting room prevents us from checking current openings.", "Open the official site and complete its verification or waiting-room step yourself.", true, "direct"],
    invalid: ["CHOOSE ANOTHER VENUE", "This listing isn’t available for alerts", options.facts || "This listing is not a public venue we can check for openings.", "Choose another venue from your dashboard to keep looking for somewhere to play.", true, "direct"],
    recovered: ["BACK ON TRACK", `We’re checking this ${venue} again`, "The latest check worked. Your alert can watch for new matching openings again.", "No action needed. We’ll email you when we find a new match.", false, "monitored"],
    stale: ["A FRESH CHECK IS NEEDED", "We need to confirm the latest openings", "The times we found earlier may have changed. We’re keeping them out of your current results until we can confirm them again.", "We’ll check again automatically. You can check the official site if you want to look right now.", false, "retrying"],
    gone: ["WE’RE STILL LOOKING", "Those earlier openings are no longer available", "The times from your previous email were no longer listed at the latest check.", "No action needed. Your alert is still running, and we’ll email you when we find a new match.", false, "monitored"],
    outside: ["WE’RE WATCHING", "There are openings outside your window", options.facts || `We found ${times} outside your saved window, but none matching your request.`, "No action needed. We’ll keep looking inside your saved window. You can also view other times on the official site.", false, "monitored"]
  } as const;
  const [badgeLabel, heading, detail, nextStep, userActionNeeded, tone] = copies[state];
  return { badgeLabel, heading, detail, nextStep, userActionNeeded, tone };
}

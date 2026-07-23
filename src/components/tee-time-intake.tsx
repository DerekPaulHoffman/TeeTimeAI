"use client";

import { SignInButton, useUser } from "@clerk/nextjs";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import type * as Leaflet from "leaflet";
import {
  Bell,
  BookOpenText,
  Check,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  CircleCheck,
  CircleDollarSign,
  ExternalLink,
  Flag,
  GripVertical,
  LocateFixed,
  LogIn,
  MapPin,
  MapPinned,
  Plus,
  Search,
  Star,
  X
} from "lucide-react";

import {
  addLocalDays,
  formatDateInputValue,
  getNextSaturdayDateInputValue
} from "@/lib/dates/local-date";
import {
  getAlertSupportDescription,
  getAlertSupportLabel,
  isManualOnlyAlertSupport
} from "@/lib/courses/intelligence";
import {
  getCourseHeadlineHoleCount,
  getCourseLayoutCompatibility,
  getCourseLayoutLabel,
  type CourseLayoutHoleCount
} from "@/lib/courses/course-layout";
import { trackWebsiteEvent } from "@/lib/engagement/client";
import {
  detectWebsiteTrafficClass,
  WEBSITE_TRAFFIC_CLASS_HEADER
} from "@/lib/engagement/traffic-class";
import { getGoogleMapsSearchUrl } from "@/lib/maps";
import {
  CURRENT_LOCATION_LABEL,
  LOCATION_INPUT_PLACEHOLDER
} from "@/lib/places/location-input";
import type { CourseCandidate } from "@/lib/places/google";
import {
  DEFAULT_COURSE_SEARCH_RADIUS_MILES,
  MAX_COURSE_SEARCH_RADIUS_MILES,
  MIN_COURSE_SEARCH_RADIUS_MILES,
  milesToMeters
} from "@/lib/places/radius";
import {
  getHeadlineCoursePrice,
  type CoursePriceEstimate,
  type CoursePriceRange
} from "@/lib/pricing/course-prices";
import {
  DEFAULT_SEARCH_CADENCE_MINUTES,
  MAX_ADDITIONAL_ALERT_EMAILS,
  MAX_PLAYERS_PER_SEARCH
} from "@/lib/validation/search";
import { buildSearchSavedMessage } from "@/lib/searches/monitoring-copy";
import {
  isAdditionalAlertEmailValid,
  normalizeAdditionalAlertEmails
} from "@/lib/searches/additional-emails";
import {
  clearSearchDraft,
  readSearchDraft,
  storeSearchDraft
} from "@/lib/searches/search-draft";
import {
  consumeSearchPrefill,
  readSearchPrefillFromUrl
} from "@/lib/searches/search-prefill";

type Notice = {
  type: "info" | "success" | "error";
  message: string;
};

declare global {
  interface Window {
    gm_authFailure?: () => void;
    google?: GoogleMapsWindow;
    initTeeTimeSpotGoogleMaps?: () => void;
  }
}

type GoogleMapsWindow = {
  maps: GoogleMapsNamespace;
};

type GoogleMapsLatLng = { lat: number; lng: number };

type GoogleMapInstance = {
  fitBounds(bounds: unknown): void;
};

type GoogleMapsNamespace = {
  LatLngBounds: new () => {
    extend(position: GoogleMapsLatLng): void;
  };
  Map: new (
    element: HTMLElement,
    options: {
      center: GoogleMapsLatLng;
      clickableIcons?: boolean;
      fullscreenControl?: boolean;
      mapId?: string;
      mapTypeControl?: boolean;
      streetViewControl?: boolean;
      zoom: number;
    }
  ) => GoogleMapInstance;
  Marker: new (options: {
    label?: string;
    map: GoogleMapInstance;
    position: GoogleMapsLatLng;
    title: string;
  }) => GoogleMapsClassicMarker;
  InfoWindow: new (options: {
    ariaLabel?: string;
    content?: Node | string;
    maxWidth?: number;
  }) => {
    close(): void;
    open(options: {
      anchor?: GoogleMapsMarker;
      map: GoogleMapInstance;
      shouldFocus?: boolean;
    }): void;
    setContent(content: Node | string): void;
  };
  marker?: {
    AdvancedMarkerElement: new (options: {
      gmpClickable?: boolean;
      map: GoogleMapInstance;
      position: GoogleMapsLatLng;
      title: string;
    }) => GoogleMapsAdvancedMarker;
    PinElement: new (options: {
      background?: string;
      borderColor?: string;
      glyphColor?: string;
      glyphText?: string;
      scale?: number;
    }) => Node;
  };
};

type GoogleMapsAdvancedMarker = {
  append?: (child: Node) => void;
  addListener?: (eventName: string, handler: () => void) => { remove?: () => void };
  map?: GoogleMapInstance | null;
};

type GoogleMapsClassicMarker = {
  addListener?: (eventName: string, handler: () => void) => { remove?: () => void };
  setMap(map: GoogleMapInstance | null): void;
};

type GoogleMapsMarker = GoogleMapsAdvancedMarker | GoogleMapsClassicMarker;

const tomorrow = () => {
  return formatDateInputValue(addLocalDays(new Date(), 1));
};

function formatCompactTimeWindow(startTime: string, endTime: string) {
  const parseTime = (value: string) => {
    const [hoursText = "0", minutes = "00"] = value.split(":");
    const hours = Number(hoursText);
    return {
      hours: hours % 12 || 12,
      minutes,
      period: hours >= 12 ? "PM" : "AM"
    };
  };
  const start = parseTime(startTime);
  const end = parseTime(endTime);

  if (start.period === end.period) {
    return `${start.hours}:${start.minutes} – ${end.hours}:${end.minutes} ${end.period}`;
  }

  const startLabel = start.minutes === "00" ? `${start.hours}` : `${start.hours}:${start.minutes}`;
  const endLabel = end.minutes === "00" ? `${end.hours}` : `${end.hours}:${end.minutes}`;
  return `${startLabel} ${start.period} – ${endLabel} ${end.period}`;
}

function formatAlertDate(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) {
    return "your selected date";
  }

  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric"
  }).format(new Date(year, month - 1, day, 12));
}

const INITIAL_VISIBLE_COURSE_COUNT = 6;
const COURSE_REVEAL_INCREMENT = 6;
const GOOGLE_MAPS_SCRIPT_CALLBACK = "initTeeTimeSpotGoogleMaps";
const LOCATION_SEARCH_ERROR_ID = "location-search-error";
let googleMapsLoaderPromise: Promise<GoogleMapsNamespace> | null = null;

type SearchCoordinates = { latitude: number; longitude: number };
type CourseLayoutFilter = "any" | "9" | "18";
type AdditionalEmailField = { id: string; value: string };

export type TeeTimeIntakeInitialValues = {
  location?: string;
  players?: number;
  date?: string;
  startTime?: string;
  endTime?: string;
  holes?: CourseLayoutFilter;
  radius?: number;
  coordinates?: SearchCoordinates;
};

type IntakeAccountState =
  | { status: "loading" | "signed-out" | "unavailable" | "missing-email" }
  | { status: "signed-in"; email: string };

export function TeeTimeIntake({
  initialValues = {},
  accountEnabled
}: {
  initialValues?: TeeTimeIntakeInitialValues;
  accountEnabled: boolean;
}) {
  if (!accountEnabled) {
    return <TeeTimeIntakeContent initialValues={initialValues} accountState={{ status: "unavailable" }} />;
  }

  return <AuthenticatedTeeTimeIntake initialValues={initialValues} />;
}

function AuthenticatedTeeTimeIntake({
  initialValues
}: {
  initialValues: TeeTimeIntakeInitialValues;
}) {
  const { isLoaded, isSignedIn, user } = useUser();

  if (!isLoaded) {
    return <TeeTimeIntakeContent initialValues={initialValues} accountState={{ status: "loading" }} />;
  }

  if (!isSignedIn) {
    return <TeeTimeIntakeContent initialValues={initialValues} accountState={{ status: "signed-out" }} />;
  }

  const email = user.primaryEmailAddress?.emailAddress;
  return (
    <TeeTimeIntakeContent
      initialValues={initialValues}
      accountState={email ? { status: "signed-in", email } : { status: "missing-email" }}
    />
  );
}

function TeeTimeIntakeContent({
  initialValues,
  accountState
}: {
  initialValues: TeeTimeIntakeInitialValues;
  accountState: IntakeAccountState;
}) {
  const router = useRouter();
  const [locationText, setLocationText] = useState(initialValues.location ?? "");
  const [searchRadiusMiles, setSearchRadiusMiles] = useState(
    initialValues.radius ?? DEFAULT_COURSE_SEARCH_RADIUS_MILES
  );
  const alertEmail = accountState.status === "signed-in" ? accountState.email : "";
  const [date, setDate] = useState(
    () => initialValues.date ?? getNextSaturdayDateInputValue()
  );
  const [startTime, setStartTime] = useState(initialValues.startTime ?? "09:00");
  const [endTime, setEndTime] = useState(initialValues.endTime ?? "18:00");
  const [players, setPlayers] = useState(initialValues.players ?? 4);
  const [additionalEmailFields, setAdditionalEmailFields] = useState<AdditionalEmailField[]>([
    { id: "additional-recipient-1", value: "" }
  ]);
  const [holeFilter, setHoleFilter] = useState<CourseLayoutFilter>(
    initialValues.holes ?? "any"
  );
  const [courses, setCourses] = useState<CourseCandidate[]>([]);
  const [searchCoordinates, setSearchCoordinates] = useState<SearchCoordinates | null>(
    initialValues.coordinates ?? null
  );
  const [visibleCourseCount, setVisibleCourseCount] = useState(INITIAL_VISIBLE_COURSE_COUNT);
  const [selected, setSelected] = useState<CourseCandidate[]>([]);
  const [courseLookupQuery, setCourseLookupQuery] = useState("");
  const [submittedCourseLookupQuery, setSubmittedCourseLookupQuery] = useState("");
  const [courseLookupResults, setCourseLookupResults] = useState<CourseCandidate[]>([]);
  const [courseLookupState, setCourseLookupState] = useState<
    "idle" | "loading" | "success" | "error"
  >("idle");
  const [courseLookupMessage, setCourseLookupMessage] = useState("");
  const [notice, setNotice] = useState<Notice>({
    type: "info",
    message: "Enter a city and state, ZIP code, or street address, or use your current location."
  });
  const [locationInputInvalid, setLocationInputInvalid] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedSignature, setSavedSignature] = useState<string | null>(null);
  const [draggedCourseId, setDraggedCourseId] = useState<string | null>(null);
  const [mobileTimeEditorOpen, setMobileTimeEditorOpen] = useState(false);
  const [mobileSelectionOpen, setMobileSelectionOpen] = useState(false);
  const [draftReady, setDraftReady] = useState(false);
  const resultsRef = useRef<HTMLDivElement | null>(null);
  const shouldScrollToResultsRef = useRef(false);
  const nextAdditionalEmailIdRef = useRef(1);
  const hasTrackedCourseSelectionRef = useRef(false);
  const reportedCourseLookupMissesRef = useRef(new Set<string>());
  const reportedCourseLookupCandidatesRef = useRef(new Set<string>());

  useEffect(() => {
    const transferred = consumeSearchPrefill() ?? readSearchPrefillFromUrl();
    const draft = transferred ? undefined : readSearchDraft();
    const animationFrame = window.requestAnimationFrame(() => {
      if (transferred) {
        if (transferred.location !== undefined) setLocationText(transferred.location);
        if (transferred.radius !== undefined) setSearchRadiusMiles(transferred.radius);
        if (transferred.date !== undefined) setDate(transferred.date);
        if (transferred.startTime !== undefined) setStartTime(transferred.startTime);
        if (transferred.endTime !== undefined) setEndTime(transferred.endTime);
        if (transferred.players !== undefined) setPlayers(transferred.players);
        if (transferred.holes !== undefined) setHoleFilter(transferred.holes);
        if (transferred.coordinates !== undefined) setSearchCoordinates(transferred.coordinates);
        if (transferred.selectedCourse !== undefined) {
          setSelected([transferred.selectedCourse]);
          setCourses([transferred.selectedCourse]);
          hasTrackedCourseSelectionRef.current = true;
        }
      } else if (draft) {
        if (draft.location !== undefined) setLocationText(draft.location);
        if (draft.radius !== undefined) setSearchRadiusMiles(draft.radius);
        if (draft.date !== undefined) setDate(draft.date);
        if (draft.startTime !== undefined) setStartTime(draft.startTime);
        if (draft.endTime !== undefined) setEndTime(draft.endTime);
        if (draft.players !== undefined) setPlayers(draft.players);
        if (draft.holes !== undefined) setHoleFilter(draft.holes);
        if (draft.coordinates !== undefined) setSearchCoordinates(draft.coordinates);
        setCourses(draft.courses);
        setSelected(draft.selectedCourses);
        hasTrackedCourseSelectionRef.current = draft.selectedCourses.length > 0;
      }

      setDraftReady(true);
    });

    return () => window.cancelAnimationFrame(animationFrame);
  }, []);

  useEffect(() => {
    if (!draftReady) {
      return;
    }

    storeSearchDraft({
      location: locationText,
      radius: searchRadiusMiles,
      date,
      startTime,
      endTime,
      players,
      holes: holeFilter,
      coordinates: searchCoordinates ?? undefined,
      courses,
      selectedCourses: selected
    });
  }, [
    courses,
    date,
    draftReady,
    endTime,
    holeFilter,
    locationText,
    players,
    searchCoordinates,
    searchRadiusMiles,
    selected,
    startTime
  ]);

  const minSearchDate = tomorrow();

  const selectedIds = useMemo(
    () => new Set(selected.map((course) => course.googlePlaceId)),
    [selected]
  );
  const normalizedAdditionalEmails = useMemo(
    () => normalizeAdditionalAlertEmails(
      additionalEmailFields.map((field) => field.value),
      alertEmail
    ),
    [additionalEmailFields, alertEmail]
  );
  const hasInvalidAdditionalEmail = additionalEmailFields.some(
    (field) => !isAdditionalAlertEmailValid(field.value)
  );
  const requestedLayoutHoles: CourseLayoutHoleCount | null =
    holeFilter === "9" ? 9 : holeFilter === "18" ? 18 : null;
  const { filteredCourses, incompatibleCourseCount } = useMemo(() => {
    const radiusMeters = milesToMeters(searchRadiusMiles);
    const withinRadius = courses.filter(
      (course) => course.distanceMeters === undefined || course.distanceMeters <= radiusMeters
    );
    const compatibleOrUnknown = withinRadius.filter(
      (course) =>
        getCourseLayoutCompatibility(course.layoutHoleCounts, requestedLayoutHoles) !==
        "incompatible"
    );

    const sortedCourses = [...compatibleOrUnknown].sort((a, b) => {
      const aCompatibility = getCourseLayoutCompatibility(
        a.layoutHoleCounts,
        requestedLayoutHoles
      );
      const bCompatibility = getCourseLayoutCompatibility(
        b.layoutHoleCounts,
        requestedLayoutHoles
      );
      const aCompatibilityRank = aCompatibility === "unknown" ? 1 : 0;
      const bCompatibilityRank = bCompatibility === "unknown" ? 1 : 0;
      return (
        aCompatibilityRank - bCompatibilityRank ||
        (a.distanceMeters ?? Number.MAX_SAFE_INTEGER) -
          (b.distanceMeters ?? Number.MAX_SAFE_INTEGER)
      );
    });

    return {
      filteredCourses: sortedCourses,
      incompatibleCourseCount: withinRadius.length - compatibleOrUnknown.length
    };
  }, [courses, requestedLayoutHoles, searchRadiusMiles]);
  const courseLookupResultIds = useMemo(
    () => new Set(courseLookupResults.map((course) => course.googlePlaceId)),
    [courseLookupResults]
  );
  const nearbyCourses = useMemo(
    () => filteredCourses.filter((course) => !courseLookupResultIds.has(course.googlePlaceId)),
    [courseLookupResultIds, filteredCourses]
  );
  const visibleNearbyCourses = useMemo(
    () => nearbyCourses.slice(0, visibleCourseCount),
    [nearbyCourses, visibleCourseCount]
  );
  const hiddenCourseCount = Math.max(nearbyCourses.length - visibleNearbyCourses.length, 0);
  const displayedCourseCount = nearbyCourses.length + courseLookupResults.length;
  const searchSignature = useMemo(
    () =>
      JSON.stringify({
        alertEmail: alertEmail.trim().toLowerCase(),
        date,
        startTime,
        endTime,
        players,
        additionalEmails: normalizedAdditionalEmails,
        requestedLayoutHoles,
        courses: selected.map((course, index) => ({
          placeId: course.googlePlaceId,
          rank: index + 1
        }))
      }),
    [
      alertEmail,
      date,
      endTime,
      normalizedAdditionalEmails,
      players,
      requestedLayoutHoles,
      selected,
      startTime
    ]
  );
  const isCurrentSearchSaved = savedSignature === searchSignature;
  const isDateFuture = date >= minSearchDate;
  const isTimeWindowValid = endTime > startTime;
  const hasMonitorableCourse = selected.some(
    (course) => !isManualOnlyAlertSupport(course.alertSupport)
  );
  const incompatibleSelectedCourse = selected.find(
    (course) =>
      getCourseLayoutCompatibility(course.layoutHoleCounts, requestedLayoutHoles) ===
      "incompatible"
  );
  const unverifiedSelectedCourse = selected.find(
    (course) => course.publicAccessStatus === "UNVERIFIED"
  );
  const saveBlocker = !isDateFuture
    ? "Choose a future date for alerts."
    : !isTimeWindowValid
      ? "Choose an end time after the start time."
      : hasInvalidAdditionalEmail
        ? "Enter a valid email for each additional recipient."
      : unverifiedSelectedCourse
        ? `${unverifiedSelectedCourse.name} still needs public-course verification. It is saved to your list, but alerts cannot start for it yet.`
      : incompatibleSelectedCourse && requestedLayoutHoles
        ? `${incompatibleSelectedCourse.name} is verified as ${getCourseLayoutLabel(incompatibleSelectedCourse.layoutHoleCounts)} and cannot be used for an ${requestedLayoutHoles}-hole course search.`
      : selected.length > 0 && !hasMonitorableCourse
        ? "Choose at least one course Tee Time Spot can monitor automatically."
        : null;

  function selectCurrentLocation() {
    setLocationInputInvalid(false);
    if (!navigator.geolocation) {
      setNotice({ type: "error", message: "This browser does not support geolocation." });
      return;
    }

    setLoading(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const coordinates = {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude
        };
        setLocationText(CURRENT_LOCATION_LABEL);
        setSearchCoordinates(coordinates);
        setCourses([]);
        setLoading(false);
        setNotice({
          type: "info",
          message: "Current location selected. Adjust your search details, then select Search."
        });
      },
      () => {
        shouldScrollToResultsRef.current = false;
        setLoading(false);
        setNotice({
          type: "error",
          message:
            "Location access was blocked. Enter a city and state, ZIP code, or street address instead."
        });
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }

  async function discoverFromSearchControls() {
    setLoading(true);
    shouldScrollToResultsRef.current = true;

    if (locationText.trim() === CURRENT_LOCATION_LABEL && searchCoordinates) {
      setLocationInputInvalid(false);
      await discoverCourses(searchCoordinates);
      return;
    }

    let responseStatus: number | undefined;
    try {
      const geocode = await fetch(
        `/api/location/geocode?q=${encodeURIComponent(locationText.trim())}`
      );
      responseStatus = geocode.status;
      if (!geocode.ok) {
        throw new Error(
          await readApiError(
            geocode,
            "We couldn't find that location. Check the city, state, or ZIP code and try again."
          )
        );
      }
      const coordinates = (await geocode.json()) as { latitude: number; longitude: number };
      setLocationInputInvalid(false);
      await discoverCourses(coordinates);
    } catch (error) {
      trackWebsiteEvent({
        name: "course_discovery_failed",
        metadata: {
          radiusMiles: searchRadiusMiles,
          stage: "GEOCODE",
          responseStatus
        }
      });
      shouldScrollToResultsRef.current = false;
      setLocationInputInvalid(true);
      setNotice({
        type: "error",
        message: error instanceof Error ? error.message : "Could not geocode that location."
      });
      setLoading(false);
    }
  }

  const discoverCourses = useCallback(async (
    coordinates: SearchCoordinates,
    radiusMiles = searchRadiusMiles
  ) => {
    let responseStatus: number | undefined;
    try {
      const params = new URLSearchParams({
        latitude: String(coordinates.latitude),
        longitude: String(coordinates.longitude),
        radiusMeters: String(milesToMeters(radiusMiles))
      });
      const response = await fetch(`/api/courses/discover?${params}`);
      responseStatus = response.status;
      if (!response.ok) {
        throw new Error(await readApiError(response, "Could not load nearby courses."));
      }

      const data = (await response.json()) as { courses: CourseCandidate[]; demo?: boolean };
      trackWebsiteEvent({
        name: "course_discovery_completed",
        metadata: {
          radiusMiles,
          resultCount: data.courses.length,
          demo: data.demo === true
        }
      });
      if (data.courses.length === 0) {
        shouldScrollToResultsRef.current = false;
      }
      setSearchCoordinates(coordinates);
      setCourses(sortCoursesByDistance(data.courses));
      setVisibleCourseCount(INITIAL_VISIBLE_COURSE_COUNT);
      setNotice({
        type: "success",
        message: data.demo
          ? "Loaded demo courses. Add Google Places keys for live discovery."
          : `Found ${data.courses.length} public golf courses within ${radiusMiles} miles.`
      });
    } catch (error) {
      trackWebsiteEvent({
        name: "course_discovery_failed",
        metadata: {
          radiusMiles,
          stage: "DISCOVERY",
          responseStatus
        }
      });
      shouldScrollToResultsRef.current = false;
      setNotice({
        type: "error",
        message: error instanceof Error ? error.message : "Could not load nearby courses."
      });
    } finally {
      setLoading(false);
    }
  }, [searchRadiusMiles]);

  function expandEmptySearch() {
    if (!searchCoordinates || searchRadiusMiles >= MAX_COURSE_SEARCH_RADIUS_MILES) {
      return;
    }

    setSearchRadiusMiles(MAX_COURSE_SEARCH_RADIUS_MILES);
    setLoading(true);
    void discoverCourses(searchCoordinates, MAX_COURSE_SEARCH_RADIUS_MILES);
  }

  useEffect(() => {
    if (!shouldScrollToResultsRef.current || courses.length === 0) {
      return;
    }

    shouldScrollToResultsRef.current = false;
    const animationFrame = window.requestAnimationFrame(() => {
      resultsRef.current?.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
        block: "start"
      });
    });

    return () => window.cancelAnimationFrame(animationFrame);
  }, [courses]);

  async function reportMissingCourseLookup(normalizedQuery: string) {
    const reportKey = `${normalizedQuery.toLowerCase()}|${locationText.trim().toLowerCase()}`;
    if (reportedCourseLookupMissesRef.current.has(reportKey)) {
      return true;
    }

    try {
      const response = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sentiment: "broken",
          message: `[COURSE_LOOKUP_MISS] ${JSON.stringify({
            query: normalizedQuery,
            location: locationText.trim() || undefined,
            latitude: searchCoordinates?.latitude,
            longitude: searchCoordinates?.longitude
          })}`,
          page: "/search#missing-course",
          contactEmail: alertEmail || undefined,
          trafficClass: detectWebsiteTrafficClass()
        })
      });

      if (response.ok) {
        reportedCourseLookupMissesRef.current.add(reportKey);
        return true;
      }
    } catch {
      // The user still gets a useful recovery path when reporting is unavailable.
    }

    return false;
  }

  async function reportCourseLookupCandidate(course: CourseCandidate) {
    if (reportedCourseLookupCandidatesRef.current.has(course.googlePlaceId)) {
      return true;
    }

    try {
      const response = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sentiment: "broken",
          message: `[COURSE_LOOKUP_CANDIDATE] Missing course requested for public-course review ${JSON.stringify({
            query: submittedCourseLookupQuery || courseLookupQuery.trim(),
            googlePlaceId: course.googlePlaceId,
            name: course.name,
            address: course.address,
            website: course.website,
            location: locationText.trim() || undefined
          })}`,
          page: "/search#missing-course",
          contactEmail: alertEmail || undefined,
          trafficClass: detectWebsiteTrafficClass()
        })
      });

      if (response.ok) {
        reportedCourseLookupCandidatesRef.current.add(course.googlePlaceId);
        return true;
      }
    } catch {
      // The shortlist still remains in this browser if the review request is unavailable.
    }

    return false;
  }

  async function addCourseLookupResult(course: CourseCandidate) {
    if (!addCourse(course)) {
      return;
    }

    if (course.publicAccessStatus !== "UNVERIFIED") {
      setCourseLookupMessage(`${course.name} was added to your list.`);
      return;
    }

    const reportSaved = await reportCourseLookupCandidate(course);
    setCourseLookupMessage(
      reportSaved
        ? `${course.name} was added to your list and saved for public-course review. Alerts can start after it is verified.`
        : `${course.name} was added to your list in this browser, but we couldn't save the review request. Please try again or send it through Feedback.`
    );
  }

  async function lookupCourse() {
    const normalizedQuery = courseLookupQuery.trim();
    if (normalizedQuery.length < 2) {
      setCourseLookupState("error");
      setCourseLookupMessage("Enter at least 2 characters from the course name.");
      return;
    }

    setSubmittedCourseLookupQuery(normalizedQuery);
    setCourseLookupResults([]);
    setCourseLookupState("loading");
    setCourseLookupMessage("Looking for matching golf coursesâ€¦");

    try {
      const params = new URLSearchParams({ q: normalizedQuery });
      if (searchCoordinates) {
        params.set("latitude", String(searchCoordinates.latitude));
        params.set("longitude", String(searchCoordinates.longitude));
      }

      const response = await fetch(`/api/courses/lookup?${params}`);
      const data = (await response.json()) as { courses?: CourseCandidate[]; error?: string };
      if (!response.ok) {
        throw new Error(data.error ?? "Could not look up that course.");
      }

      const matches = data.courses ?? [];
      setCourseLookupResults(matches);
      setCourseLookupState("success");
      const missWasReported = matches.length === 0
        ? await reportMissingCourseLookup(normalizedQuery)
        : false;
      setCourseLookupMessage(
        matches.length === 0
          ? missWasReported
            ? `We couldn't find â€œ${normalizedQuery}â€ yet. We've logged it for review and will look into it.`
            : `We couldn't find â€œ${normalizedQuery}â€ yet. Try the full course name plus its city or state, or send it through Feedback so we can investigate.`
          : `${matches.length} ${matches.length === 1 ? "match" : "matches"} found.`
      );
    } catch (error) {
      setCourseLookupResults([]);
      setCourseLookupState("error");
      setCourseLookupMessage(
        error instanceof Error ? error.message : "Could not look up that course."
      );
    }
  }

  function addCourse(course: CourseCandidate) {
    if (
      getCourseLayoutCompatibility(course.layoutHoleCounts, requestedLayoutHoles) ===
      "incompatible"
    ) {
      setNotice({
        type: "error",
        message: `${course.name} is verified as ${getCourseLayoutLabel(course.layoutHoleCounts)} and does not match this ${requestedLayoutHoles}-hole course search.`
      });
      return false;
    }

    if (selected.length >= 5) {
      setNotice({ type: "error", message: "You can prioritize up to 5 courses." });
      return false;
    }

    if (selectedIds.has(course.googlePlaceId)) {
      return false;
    }

    if (!hasTrackedCourseSelectionRef.current) {
      hasTrackedCourseSelectionRef.current = true;
      trackWebsiteEvent({
        name: "course_selection_started",
        metadata: {
          selectedCourseCount: 1,
          players,
          requestedLayoutHoles
        }
      });
    }

    setSelected((current) => [...current, course]);
    return true;
  }

  function toggleCourse(course: CourseCandidate) {
    if (selectedIds.has(course.googlePlaceId)) {
      removeCourse(course.googlePlaceId);
      return;
    }

    addCourse(course);
  }

  function removeCourse(placeId: string) {
    const nextSelected = selected.filter((course) => course.googlePlaceId !== placeId);
    setSelected(nextSelected);
    if (nextSelected.length === 0) {
      setMobileSelectionOpen(false);
    }
  }

  function moveSelectedCourse(placeId: string, direction: -1 | 1) {
    setSelected((current) => {
      const index = current.findIndex((course) => course.googlePlaceId === placeId);
      const nextIndex = index + direction;
      if (index < 0 || nextIndex < 0 || nextIndex >= current.length) {
        return current;
      }

      const next = [...current];
      [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
      return next;
    });
  }

  function reorderSelectedCourse(sourcePlaceId: string, targetPlaceId: string) {
    if (sourcePlaceId === targetPlaceId) {
      return;
    }

    setSelected((current) => {
      const sourceIndex = current.findIndex((course) => course.googlePlaceId === sourcePlaceId);
      const targetIndex = current.findIndex((course) => course.googlePlaceId === targetPlaceId);

      if (sourceIndex < 0 || targetIndex < 0) {
        return current;
      }

      const next = [...current];
      const [moved] = next.splice(sourceIndex, 1);
      next.splice(targetIndex, 0, moved);
      return next;
    });
  }

  function showMoreCourses() {
    setVisibleCourseCount((current) =>
      Math.min(current + COURSE_REVEAL_INCREMENT, nearbyCourses.length)
    );
  }

  function updateAdditionalEmail(id: string, value: string) {
    setAdditionalEmailFields((current) =>
      current.map((field) => (field.id === id ? { ...field, value } : field))
    );
  }

  function addAdditionalEmailField() {
    setAdditionalEmailFields((current) => {
      if (current.length >= MAX_ADDITIONAL_ALERT_EMAILS) {
        return current;
      }

      nextAdditionalEmailIdRef.current += 1;
      return [
        ...current,
        { id: `additional-recipient-${nextAdditionalEmailIdRef.current}`, value: "" }
      ];
    });
  }

  function removeAdditionalEmailField(id: string) {
    setAdditionalEmailFields((current) => {
      const next = current.filter((field) => field.id !== id);
      return next.length > 0
        ? next
        : [{ id: `additional-recipient-${nextAdditionalEmailIdRef.current}`, value: "" }];
    });
  }

  async function saveSearch() {
    if (accountState.status !== "signed-in") {
      setNotice({
        type: "error",
        message: "Sign in or create an account before starting alerts."
      });
      return;
    }

    if (saveBlocker) {
      setNotice({ type: "error", message: saveBlocker });
      return;
    }

    if (!alertEmail.trim()) {
      setNotice({ type: "error", message: "Enter the email that should receive tee time alerts." });
      return;
    }

    setSaving(true);
    try {
      const userTimeZone =
        Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York";
      const response = await fetch("/api/searches", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [WEBSITE_TRAFFIC_CLASS_HEADER]: detectWebsiteTrafficClass()
        },
        body: JSON.stringify({
          date,
          startTime,
          endTime,
          userTimeZone,
          players,
          additionalEmails: normalizedAdditionalEmails,
          requestedLayoutHoles,
          cadenceMinutes: DEFAULT_SEARCH_CADENCE_MINUTES,
          courses: selected.map((course, index) => ({
            ...course,
            rank: index + 1
          }))
        })
      });

      if (!response.ok) {
        const responseBody = (await response.json().catch(() => null)) as { error?: string } | null;
        trackWebsiteEvent({
          name: "search_submission_failed",
          metadata: {
            responseStatus: response.status,
            selectedCourseCount: selected.length,
            players,
            requestedLayoutHoles
          }
        });
        throw new Error(responseBody?.error ?? "Could not save this search. Try again in a moment.");
      }

      setNotice({
        type: "success",
        message: buildSearchSavedMessage(selected)
      });
      trackWebsiteEvent({
        name: "search_submitted",
        metadata: {
          selectedCourseCount: selected.length,
          players,
          requestedLayoutHoles
        }
      });
      setSavedSignature(searchSignature);
      const responseBody = (await response.json().catch(() => null)) as {
        search?: { id?: string };
      } | null;
      const createdSearchId = responseBody?.search?.id;
      clearSearchDraft();
      router.push(
        createdSearchId
          ? `/dashboard?created=${encodeURIComponent(createdSearchId)}`
          : "/dashboard"
      );
    } catch (error) {
      setNotice({
        type: "error",
        message:
          error instanceof Error
            ? error.message
            : "Could not save this search. Try again in a moment."
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="figma-search-experience">
      <form
        aria-label="Course search filters"
        className="figma-search-toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          void discoverFromSearchControls();
        }}
      >
        <div className="figma-search-primary">
          <div className="figma-search-field figma-location-field">
            <label htmlFor="location">Location</label>
            <div className="figma-search-value">
              <span className="figma-search-value-icon" aria-hidden="true">📍</span>
              <input
                aria-describedby={locationInputInvalid ? LOCATION_SEARCH_ERROR_ID : undefined}
                aria-invalid={locationInputInvalid}
                id="location"
                value={locationText}
                onChange={(event) => {
                  setLocationText(event.target.value);
                  setSearchCoordinates(null);
                  setLocationInputInvalid(false);
                }}
                placeholder={LOCATION_INPUT_PLACEHOLDER}
              />
            </div>
            <button
              aria-label="Use current location"
              className="figma-use-location"
              disabled={loading}
              onClick={selectCurrentLocation}
              title="Use current location"
              type="button"
            >
              <LocateFixed size={15} />
            </button>
          </div>
          <label className="figma-search-field" htmlFor="players">
            <span>Players</span>
            <div className="figma-search-value">
              <span className="figma-search-value-icon" aria-hidden="true">🏌️</span>
              <select
                id="players"
                value={players}
                onChange={(event) => setPlayers(Number(event.target.value))}
              >
                {Array.from({ length: MAX_PLAYERS_PER_SEARCH }, (_, index) => index + 1).map((count) => (
                  <option key={count} value={count}>
                    {count} {count === 1 ? "player" : "players"}
                  </option>
                ))}
              </select>
            </div>
          </label>
          <label className="figma-search-field" htmlFor="date">
            <span>Date</span>
            <div className="figma-search-value">
              <span className="figma-search-value-icon" aria-hidden="true">📅</span>
              <input
                aria-invalid={!isDateFuture}
                aria-describedby={!isDateFuture ? "search-form-guidance" : undefined}
                id="date"
                min={minSearchDate}
                type="date"
                value={date}
                onChange={(event) => setDate(event.target.value)}
              />
            </div>
          </label>
        </div>
        <div className="figma-filter-strip">
          <div
            aria-label="Time window"
            aria-describedby="time-window-help"
            className="figma-search-field figma-time-field"
            role="group"
          >
            <span className="figma-time-label">Time</span>
            <div className="figma-search-value">
              <span className="figma-search-value-icon" aria-hidden="true">⏰</span>
              <button
                aria-controls="mobile-time-editor"
                aria-expanded={mobileTimeEditorOpen}
                className="figma-time-summary"
                onClick={() => setMobileTimeEditorOpen((open) => !open)}
                type="button"
              >
                {formatCompactTimeWindow(startTime, endTime)}
              </button>
              <div
                className={`figma-time-inputs${mobileTimeEditorOpen ? " is-mobile-open" : ""}`}
                id="mobile-time-editor"
              >
                <input
                  aria-label="Start time"
                  id="startTime"
                  type="time"
                  value={startTime}
                  onChange={(event) => setStartTime(event.target.value)}
                />
                <span aria-hidden="true">–</span>
                <input
                  aria-describedby={!isTimeWindowValid ? "search-form-guidance" : undefined}
                  aria-invalid={!isTimeWindowValid}
                  aria-label="End time"
                  id="endTime"
                  type="time"
                  value={endTime}
                  onChange={(event) => setEndTime(event.target.value)}
                />
                <button
                  className="figma-time-editor-done"
                  onClick={() => setMobileTimeEditorOpen(false)}
                  type="button"
                >
                  Done
                </button>
              </div>
            </div>
            <span className="sr-only" id="time-window-help">
              Times use each course&apos;s local time zone.
            </span>
          </div>
          <div className="figma-hole-filter" aria-label="Course layout">
            <strong>
              <span className="figma-desktop-copy">Course layout</span>
              <span className="figma-mobile-copy">Holes</span>
            </strong>
            <div className="figma-hole-options">
              {(["any", "9", "18"] as const).map((value) => (
                <button
                  aria-label={value === "any" ? "Any" : `${value}-hole`}
                  aria-pressed={holeFilter === value}
                  className={holeFilter === value ? "is-active" : ""}
                  key={value}
                  onClick={() => setHoleFilter(value)}
                  type="button"
                >
                  {value === "any" ? "Any" : (
                    <>
                      <span className="figma-desktop-copy">{value}-hole</span>
                      <span className="figma-mobile-copy">{value}H</span>
                    </>
                  )}
                </button>
              ))}
            </div>
          </div>
          <span className="figma-filter-divider" aria-hidden="true" />
          <div className="figma-distance-group">
            <div className="figma-distance-heading">
              <strong className="figma-distance-label">Within</strong>
            </div>
            <label className="figma-distance-filter" htmlFor="searchRadius">
              <span>
                <em>{MIN_COURSE_SEARCH_RADIUS_MILES} mi</em>
                <b><span className="figma-distance-prefix">within </span>{searchRadiusMiles} mi</b>
                <em>{MAX_COURSE_SEARCH_RADIUS_MILES} mi</em>
              </span>
              <input
                aria-label="Distance from me"
                disabled={loading}
                id="searchRadius"
                max={MAX_COURSE_SEARCH_RADIUS_MILES}
                min={MIN_COURSE_SEARCH_RADIUS_MILES}
                step="5"
                type="range"
                value={searchRadiusMiles}
                onChange={(event) => setSearchRadiusMiles(Number(event.target.value))}
                style={{
                  background: `linear-gradient(to right, #18332b 0 ${((searchRadiusMiles - MIN_COURSE_SEARCH_RADIUS_MILES) / (MAX_COURSE_SEARCH_RADIUS_MILES - MIN_COURSE_SEARCH_RADIUS_MILES)) * 100}%, #d9e4df ${((searchRadiusMiles - MIN_COURSE_SEARCH_RADIUS_MILES) / (MAX_COURSE_SEARCH_RADIUS_MILES - MIN_COURSE_SEARCH_RADIUS_MILES)) * 100}% 100%)`
                }}
              />
            </label>
            {holeFilter !== "any" || searchRadiusMiles !== DEFAULT_COURSE_SEARCH_RADIUS_MILES ? (
              <button
                className="figma-reset-filters"
                onClick={() => {
                  setHoleFilter("any");
                  setSearchRadiusMiles(DEFAULT_COURSE_SEARCH_RADIUS_MILES);
                }}
                type="button"
              >
                <X size={10} />
                Clear
              </button>
            ) : null}
          </div>
          <button
            className="figma-search-submit"
            disabled={loading || locationText.trim().length === 0}
            type="submit"
          >
            <Search size={15} />
            {loading ? "Searching" : "Search"}
          </button>
        </div>
      </form>

      <MissingCourseLookup
        lookupMessage={courseLookupMessage}
        lookupState={courseLookupState}
        onQueryChange={setCourseLookupQuery}
        onSubmit={() => void lookupCourse()}
        query={courseLookupQuery}
        showVisibleMessage={
          courseLookupState === "error" ||
          courseLookupResults.length === 0 ||
          !courseLookupMessage.endsWith("found.")
        }
      />

      <div className="figma-results-layout" ref={resultsRef}>
        <div className="figma-results-column">
          {loading ? (
            <div className="figma-results-banner" role="status" aria-atomic="true">
              <strong>Searching public courses</strong> within {searchRadiusMiles} miles…
            </div>
          ) : courses.length > 0 ? (
            <div className="figma-results-banner" role="status" aria-atomic="true">
              <strong>
                {displayedCourseCount} {displayedCourseCount === 1 ? "course" : "courses"}
              </strong>{" "}
              near {locationText.trim() || "your location"} — tap the ones you want and drag to rank them.
            </div>
          ) : courseLookupResults.length > 0 ? (
            <div className="figma-results-banner" role="status" aria-atomic="true">
              <strong>
                {courseLookupResults.length}{" "}
                {courseLookupResults.length === 1 ? "course" : "courses"}
              </strong>{" "}
              found by name — tap the ones you want and drag to rank them.
            </div>
          ) : notice.type === "success" ? (
            <div className="figma-empty-results" role="status" aria-atomic="true">
              <h3>No public courses found within {searchRadiusMiles} miles.</h3>
              <p>
                {searchRadiusMiles < MAX_COURSE_SEARCH_RADIUS_MILES
                  ? `Widen the search to ${MAX_COURSE_SEARCH_RADIUS_MILES} miles, or look up a course by name below.`
                  : `You searched the full ${MAX_COURSE_SEARCH_RADIUS_MILES}-mile range. Look up a course by name below and we'll review any miss.`}
              </p>
              {searchRadiusMiles < MAX_COURSE_SEARCH_RADIUS_MILES ? (
                <button
                  className="button button-ghost"
                  disabled={loading}
                  onClick={expandEmptySearch}
                  type="button"
                >
                  {loading ? "Searching" : `Search ${MAX_COURSE_SEARCH_RADIUS_MILES} miles`}
                </button>
              ) : null}
            </div>
          ) : (
            <Notice
              id={locationInputInvalid ? LOCATION_SEARCH_ERROR_ID : undefined}
              notice={notice}
            />
          )}
          {courses.length > 0 && notice.type === "error" ? (
            <Notice
              id={locationInputInvalid ? LOCATION_SEARCH_ERROR_ID : undefined}
              notice={notice}
            />
          ) : null}
          {isCurrentSearchSaved && notice.type === "success" ? <Notice notice={notice} /> : null}
          {courses.length > 0 &&
          filteredCourses.length === 0 &&
          courseLookupResults.length === 0 ? (
            <div className="figma-empty-results">
              <h3>No courses match these filters.</h3>
              <p>Show all nearby courses or expand the distance to keep looking.</p>
              <button
                className="button button-ghost"
                onClick={() => {
                  setHoleFilter("any");
                  setSearchRadiusMiles(50);
                }}
                type="button"
              >
                Expand search
              </button>
            </div>
          ) : null}
          {courseLookupResults.length > 0 ? (
            <>
              <CourseResultsDivider>
                Direct search · &quot;{submittedCourseLookupQuery}&quot;
              </CourseResultsDivider>
              <div
                className="course-list figma-course-list"
                role="list"
                aria-label="Direct course matches"
              >
                {courseLookupResults.map((course) => (
                  <CourseResultCard
                    course={course}
                    key={course.googlePlaceId}
                    onToggle={(lookupCourseResult) => {
                      if (selectedIds.has(lookupCourseResult.googlePlaceId)) {
                        removeCourse(lookupCourseResult.googlePlaceId);
                      } else {
                        void addCourseLookupResult(lookupCourseResult);
                      }
                    }}
                    requestedLayoutHoles={requestedLayoutHoles}
                    selectedIndex={selected.findIndex(
                      (selectedCourse) =>
                        selectedCourse.googlePlaceId === course.googlePlaceId
                    )}
                  />
                ))}
              </div>
            </>
          ) : null}

          {courseLookupResults.length > 0 && nearbyCourses.length > 0 ? (
            <CourseResultsDivider>Courses near you</CourseResultsDivider>
          ) : null}

          {visibleNearbyCourses.length > 0 ? (
            <div className="course-list figma-course-list" role="list" aria-label="Nearby courses">
              {visibleNearbyCourses.map((course) => (
                <CourseResultCard
                  course={course}
                  key={course.googlePlaceId}
                  onToggle={toggleCourse}
                  requestedLayoutHoles={requestedLayoutHoles}
                  selectedIndex={selected.findIndex(
                    (selectedCourse) =>
                      selectedCourse.googlePlaceId === course.googlePlaceId
                  )}
                />
              ))}
            </div>
          ) : null}

        {nearbyCourses.length > INITIAL_VISIBLE_COURSE_COUNT ? (
          <div className="course-list-footer">
            <span>
              Showing {visibleNearbyCourses.length} of {nearbyCourses.length} locations
            </span>
            {hiddenCourseCount > 0 ? (
              <button className="button button-ghost" type="button" onClick={showMoreCourses}>
                <Plus size={16} />
                See more locations
              </button>
            ) : null}
          </div>
        ) : null}
        {courses.length > 0 ? (
          <p className="course-pricing-note">
            <CircleDollarSign size={14} aria-hidden="true" />
            Estimates use recently observed official tee-sheet rates. Final rates can vary.
          </p>
        ) : null}
        {requestedLayoutHoles && incompatibleCourseCount > 0 ? (
          <p className="course-pricing-note" role="status">
            <Flag size={14} aria-hidden="true" />
            Hiding {incompatibleCourseCount} verified{" "}
            {incompatibleCourseCount === 1 ? "course" : "courses"} without an{" "}
            {requestedLayoutHoles}-hole layout. Unverified courses follow verified matches.
          </p>
        ) : null}
        </div>

      <aside
        className={
          mobileSelectionOpen
            ? "summary-panel figma-selected-panel is-mobile-open"
            : "summary-panel figma-selected-panel"
        }
        id="mobile-watchlist-panel"
      >
        <div className="figma-selected-header">
          <span className="figma-selected-icon">
            <MapPinned size={18} />
          </span>
          <h2>Your courses</h2>
          {selected.length > 0 ? <span className="figma-count-pill">{selected.length}/5</span> : null}
        </div>
        <p>Pick up to 5. Drag to rank them. Supported courses are checked automatically.</p>
        <div className="selected-list">
          {selected.length === 0 ? (
            <div className="selected-empty">
              <span className="figma-empty-flag" aria-hidden="true">⛳</span>
              <span>Tap a course to add it here</span>
            </div>
          ) : (
            selected.map((course, index) => (
              <div
                className={
                  draggedCourseId === course.googlePlaceId
                    ? "selected-row selected-card figma-selected-card is-dragging"
                    : "selected-row selected-card figma-selected-card"
                }
                draggable
                key={course.googlePlaceId}
                onDragEnd={() => setDraggedCourseId(null)}
                onDragOver={(event) => event.preventDefault()}
                onDragStart={() => setDraggedCourseId(course.googlePlaceId)}
                onDrop={(event) => {
                  event.preventDefault();
                  if (draggedCourseId) {
                    reorderSelectedCourse(draggedCourseId, course.googlePlaceId);
                    setDraggedCourseId(null);
                  }
                }}
              >
                <GripVertical className="figma-drag-handle" size={16} />
                <span className="figma-selected-rank">{index + 1}</span>
                <CourseThumbnail course={course} variant="compact" />
                <div className="selected-copy">
                  <h3>{course.name}</h3>
                  {course.layoutHoleCounts?.length ? (
                    <span className="selected-course-support">
                      {getCourseLayoutLabel(course.layoutHoleCounts)} course
                    </span>
                  ) : requestedLayoutHoles ? (
                    <span className="selected-course-support">Layout unverified</span>
                  ) : null}
                  {course.publicAccessStatus === "UNVERIFIED" ? (
                    <span className="selected-course-support">
                      Public access verification needed
                    </span>
                  ) : course.alertSupport ? (
                    <span className="selected-course-support">
                      {getAlertSupportLabel(course.alertSupport)}
                    </span>
                  ) : course.monitoringSupport !== "AUTOMATIC" ? (
                    <span className="selected-course-support">Alerts not yet confirmed</span>
                  ) : null}
                </div>
                <div className="figma-reorder-controls" aria-label={`Reorder ${course.name}`}>
                  <button
                    aria-label={`Move ${course.name} up`}
                    disabled={index === 0}
                    onClick={() => moveSelectedCourse(course.googlePlaceId, -1)}
                    type="button"
                  >
                    <ChevronUp size={15} />
                  </button>
                  <button
                    aria-label={`Move ${course.name} down`}
                    disabled={index === selected.length - 1}
                    onClick={() => moveSelectedCourse(course.googlePlaceId, 1)}
                    type="button"
                  >
                    <ChevronDown size={15} />
                  </button>
                </div>
                <button
                  className="figma-remove-course"
                  type="button"
                  onClick={() => removeCourse(course.googlePlaceId)}
                  title="Remove course"
                  aria-label={`Remove ${course.name}`}
                >
                  <X size={17} />
                </button>
              </div>
            ))
          )}
        </div>
        {selected.length > 0 ? (
          <section className="figma-alert-preview" aria-labelledby="alert-preview-title">
            <div className="figma-alert-preview-heading">
              <Bell aria-hidden="true" size={16} />
              <strong id="alert-preview-title">Your alert</strong>
            </div>
            <p>
              We&apos;ll check {selected.length} ranked {selected.length === 1 ? "course" : "courses"}
              {" "}for {formatAlertDate(date)}, {formatCompactTimeWindow(startTime, endTime)}, for{" "}
              {players} {players === 1 ? "player" : "players"}.
            </p>
            <span className="figma-alert-preview-recipients">
              {normalizedAdditionalEmails.length > 0
                ? `Your account email + ${normalizedAdditionalEmails.length} ${normalizedAdditionalEmails.length === 1 ? "other" : "others"}`
                : "Your account email"}
            </span>
            <small>Matching openings link to the official site. You book direct.</small>
          </section>
        ) : null}
        {selected.length > 0 ? (
          <label className="figma-alert-email" htmlFor="alertEmail">
            <span>Alert email from your account</span>
            <input
              aria-describedby="search-form-guidance"
              disabled={accountState.status !== "signed-in"}
              id="alertEmail"
              readOnly
              type="email"
              value={alertEmail}
              placeholder={
                accountState.status === "signed-out"
                  ? "Sign in to use your account email"
                  : "Account email unavailable"
              }
            />
          </label>
        ) : null}
        {selected.length > 0 ? (
          <fieldset className="figma-group-recipients">
            <legend>Alert your group too</legend>
            <p id="additional-recipient-help">
              Add up to 3 people. Everyone gets the same opening, but only you manage the alert.
            </p>
            <div className="figma-recipient-fields">
              {additionalEmailFields.map((field, index) => (
                <div className="figma-recipient-row" key={field.id}>
                  <input
                    aria-describedby="additional-recipient-help"
                    aria-invalid={!isAdditionalAlertEmailValid(field.value)}
                    aria-label={`Additional recipient ${index + 1}`}
                    autoComplete="email"
                    onChange={(event) => updateAdditionalEmail(field.id, event.target.value)}
                    placeholder="friend@example.com"
                    type="email"
                    value={field.value}
                  />
                  {(additionalEmailFields.length > 1 || field.value.trim()) ? (
                    <button
                      aria-label={`Remove additional recipient ${index + 1}`}
                      onClick={() => removeAdditionalEmailField(field.id)}
                      type="button"
                    >
                      <X size={15} />
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
            <div className="figma-recipient-footer">
              {additionalEmailFields.length < MAX_ADDITIONAL_ALERT_EMAILS ? (
                <button
                  className="figma-add-recipient"
                  onClick={addAdditionalEmailField}
                  type="button"
                >
                  <Plus size={14} />
                  Add another recipient
                </button>
              ) : null}
              <span>
                {normalizedAdditionalEmails.length}/{MAX_ADDITIONAL_ALERT_EMAILS} added
              </span>
            </div>
          </fieldset>
        ) : null}
        {accountState.status === "signed-out" ? (
          <SignInButton mode="modal">
            <button
              className="button button-primary"
              disabled={Boolean(saveBlocker) || selected.length === 0}
              onClick={() => {
                trackWebsiteEvent({
                  name: "alert_sign_in_clicked",
                  metadata: {
                    selectedCourseCount: selected.length,
                    players,
                    requestedLayoutHoles
                  }
                });
              }}
              style={{ marginTop: 18, width: "100%" }}
              type="button"
            >
              <LogIn size={17} />
              Sign in to start sending alerts
            </button>
          </SignInButton>
        ) : (
          <button
            className="button button-primary"
            type="button"
            onClick={saveSearch}
            disabled={
              accountState.status !== "signed-in" ||
              saving ||
              isCurrentSearchSaved ||
              Boolean(saveBlocker) ||
              selected.length === 0 ||
              !alertEmail.trim()
            }
            style={{ marginTop: 18, width: "100%" }}
          >
            {saving ? (
              <Bell size={17} />
            ) : isCurrentSearchSaved ? (
              <Check size={17} />
            ) : (
              <Bell size={17} />
            )}
            {accountState.status === "loading"
              ? "Checking your account"
              : accountState.status === "missing-email"
                ? "Account email required"
                : accountState.status === "unavailable"
                  ? "Account access unavailable"
                  : saving
                    ? "Starting alerts"
                    : isCurrentSearchSaved
                      ? "Search saved"
                      : "Start getting alerts"}
          </button>
        )}
        <p className="helper" id="search-form-guidance">
          {saveBlocker ??
            (accountState.status === "signed-out"
              ? "Sign in or create an account so you can change, pause, or stop your alerts later."
              : accountState.status === "loading"
                ? "Checking your account before alerts can be created."
                : accountState.status === "missing-email"
                  ? "Add a primary email to your account before creating alerts."
                  : accountState.status === "unavailable"
                    ? "Account access is temporarily unavailable, so alerts cannot be created."
                    : `Alerts will be sent to ${alertEmail} and stay manageable from your account.`)}
        </p>
      </aside>
      </div>
      <CourseResultsMap courses={[]} origin={searchCoordinates} />
      {selected.length > 0 ? (
        <div className="mobile-selection-bar">
          <button
            aria-controls="mobile-watchlist-panel"
            aria-expanded={mobileSelectionOpen}
            className="mobile-selection-toggle"
            type="button"
            onClick={() => setMobileSelectionOpen((open) => !open)}
          >
            <span className="mobile-selection-summary">
              <span className="mobile-selection-ranks" aria-hidden="true">
                <span>{selected.length}</span>
              </span>
              <span className="mobile-selection-copy">
                <strong>
                  {selected.length} {selected.length === 1 ? "course" : "courses"} picked
                </strong>
                <span className="mobile-selection-view">
                  Reorder priority
                  <ChevronDown className={mobileSelectionOpen ? "is-open" : ""} size={15} />
                </span>
              </span>
            </span>
          </button>
          <button
            aria-controls="mobile-watchlist-panel"
            aria-expanded={mobileSelectionOpen}
            className="mobile-selection-submit"
            type="button"
            onClick={() => setMobileSelectionOpen(true)}
          >
            Review alert <span aria-hidden="true">→</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}

function CourseResultsDivider({ children }: { children: ReactNode }) {
  return (
    <div className="course-results-divider">
      <span aria-hidden="true" />
      <p>{children}</p>
      <span aria-hidden="true" />
    </div>
  );
}

function CourseResultCard({
  course,
  onToggle,
  requestedLayoutHoles,
  selectedIndex
}: {
  course: CourseCandidate;
  onToggle: (course: CourseCandidate) => void;
  requestedLayoutHoles: CourseLayoutHoleCount | null;
  selectedIndex: number;
}) {
  const isSelected = selectedIndex >= 0;
  const layoutCompatibility = getCourseLayoutCompatibility(
    course.layoutHoleCounts,
    requestedLayoutHoles
  );
  const isIncompatible = layoutCompatibility === "incompatible";
  const cardHoleCount = getCourseHeadlineHoleCount(
    course.layoutHoleCounts,
    course.bookableHoleCounts
  );
  const isPublicAccessUnverified = course.publicAccessStatus === "UNVERIFIED";

  return (
    <div
      className={isSelected ? "course-row course-row-selected" : "course-row"}
      role="listitem"
    >
      <CourseThumbnail course={course} />
      {isSelected ? <span className="course-rank-overlay">{selectedIndex + 1}</span> : null}
      <div className="course-copy">
        <div className="figma-course-badges">
          <span
            className={
              isPublicAccessUnverified
                ? "figma-course-pill is-unverified"
                : "figma-course-pill is-public"
            }
          >
            {isPublicAccessUnverified ? "Possible course" : "Public"}
          </span>
          {course.rating ? (
            <span className="figma-course-pill is-rating">
              <Star aria-hidden="true" fill="currentColor" size={10} />
              {course.rating.toFixed(1)}
            </span>
          ) : null}
          {course.distanceMeters !== undefined ? (
            <span className="figma-course-pill is-detail">
              <span aria-hidden="true">·</span> {formatDistance(course.distanceMeters)}
            </span>
          ) : null}
          {cardHoleCount ? (
            <span
              className="figma-course-pill is-detail"
              title="Recently observed official booking options"
            >
              <span aria-hidden="true">·</span> {cardHoleCount}H
            </span>
          ) : null}
          {course.par ? (
            <span className="figma-course-pill is-detail">
              <span aria-hidden="true">·</span> Par {course.par}
            </span>
          ) : null}
          {requestedLayoutHoles && layoutCompatibility === "unknown" ? (
            <span className="figma-course-pill is-detail">
              <span aria-hidden="true">·</span> Layout unverified
            </span>
          ) : null}
          <CourseHeadlinePrice
            estimate={course.priceEstimate}
            preferredHoleCounts={cardHoleCount ? [cardHoleCount] : undefined}
          />
        </div>
        <h3>
          {course.profileUrl ? (
            <Link href={course.profileUrl as `/courses/${string}`}>{course.name}</Link>
          ) : (
            course.name
          )}
        </h3>
        <CourseAddressLink course={course} />
        <CourseMonitoringStatus course={course} />
        {isIncompatible && requestedLayoutHoles ? (
          <p className="course-alert-support-note">
            Does not match an {requestedLayoutHoles}-hole course search
          </p>
        ) : null}
      </div>
      <div className="course-actions">
        {course.profileUrl ? (
          <Link
            aria-label={`View course guide for ${course.name}`}
            className="button button-ghost course-profile-button"
            href={course.profileUrl as `/courses/${string}`}
          >
            <BookOpenText aria-hidden="true" size={10} />
            Course guide
          </Link>
        ) : null}
        {course.website ? (
          <a
            className="button button-ghost"
            href={course.website}
            aria-label={`Open official site for ${course.name}`}
            rel="noreferrer"
            target="_blank"
          >
            <ExternalLink aria-hidden="true" size={10} />
            Official site
          </a>
        ) : null}
        <button
          aria-label={isSelected ? `Remove ${course.name}` : `Add ${course.name}`}
          className={isSelected ? "figma-add-button is-added" : "figma-add-button"}
          disabled={isIncompatible && !isSelected}
          onClick={() => onToggle(course)}
          title={
            isSelected
              ? `Remove priority ${selectedIndex + 1}`
              : isIncompatible
                ? `Does not match this ${requestedLayoutHoles}-hole course search`
                : "Add course"
          }
          type="button"
        >
          {isSelected ? (
            <>
              <Check aria-hidden="true" size={10} />
              Added
            </>
          ) : isIncompatible ? (
            "Doesn’t match"
          ) : (
            "+ Add to my list"
          )}
        </button>
      </div>
    </div>
  );
}

function MissingCourseLookup({
  lookupMessage,
  lookupState,
  onQueryChange,
  onSubmit,
  query,
  showVisibleMessage
}: {
  lookupMessage: string;
  lookupState: "idle" | "loading" | "success" | "error";
  onQueryChange: (query: string) => void;
  onSubmit: () => void;
  query: string;
  showVisibleMessage: boolean;
}) {
  return (
    <section className="missing-course-lookup" aria-labelledby="missing-course-heading" id="missing-course">
      <div className="missing-course-heading">
        <h2 id="missing-course-heading">Looking for a specific course?</h2>
        <p>Can&apos;t find it in the list? Search by name and town.</p>
      </div>
      <form
        className="missing-course-form"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <label className="sr-only" htmlFor="missingCourseQuery">
          Course name and town
        </label>
        <div className="missing-course-controls">
          <div className="missing-course-input">
            <Search aria-hidden="true" size={15} />
            <input
              autoComplete="off"
              id="missingCourseQuery"
              maxLength={120}
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder="e.g. Bethpage Black, Farmingdale NY"
              type="search"
              value={query}
            />
          </div>
          <button disabled={lookupState === "loading"} type="submit">
            {lookupState === "loading" ? "Looking…" : "Find course"}
          </button>
        </div>
      </form>
      {lookupMessage ? (
        <p
          className={
            showVisibleMessage
              ? `missing-course-status ${lookupState === "error" ? "is-error" : ""}`
              : "sr-only"
          }
          role={lookupState === "error" ? "alert" : "status"}
        >
          {lookupMessage}
        </p>
      ) : null}
    </section>
  );
}

function CourseThumbnail({
  course,
  emptyLabel,
  variant = "default"
}: {
  course: CourseCandidate;
  emptyLabel?: string;
  variant?: "default" | "compact";
}) {
  const className =
    variant === "compact" ? "course-thumbnail course-thumbnail-compact" : "course-thumbnail";
  const [failedPhotoReference, setFailedPhotoReference] = useState<string | null>(null);
  const photoReference =
    course.photoReference && course.photoReference !== failedPhotoReference
      ? course.photoReference
      : null;

  if (!photoReference) {
    return (
      <div className={`${className} course-thumbnail-empty`} aria-hidden="true">
        <MapPinned size={22} />
        {emptyLabel ? <span className="course-thumbnail-empty-label">{emptyLabel}</span> : null}
      </div>
    );
  }

  return (
    <Image
      alt={`${course.name} course photo`}
      className={className}
      height={variant === "compact" ? 72 : 90}
      loading="lazy"
      onError={() => setFailedPhotoReference(photoReference)}
      src={`/api/courses/photo?ref=${encodeURIComponent(photoReference)}`}
      unoptimized
      width={variant === "compact" ? 96 : 120}
    />
  );
}

function CourseAddressLink({
  course,
  unavailableText = "Address unavailable"
}: {
  course: CourseCandidate;
  unavailableText?: string;
}) {
  if (!course.address) {
    return <p className="meta">{unavailableText}</p>;
  }

  return (
    <p className="meta">
      <a
        className="course-address-link"
        href={getGoogleMapsSearchUrl(course)}
        rel="noreferrer"
        target="_blank"
      >
        <MapPin size={14} />
        {course.address}
      </a>
    </p>
  );
}

function CourseMonitoringStatus({
  course,
  compact = false
}: {
  course: CourseCandidate;
  compact?: boolean;
}) {
  const isPublicAccessUnverified = course.publicAccessStatus === "UNVERIFIED";
  const isManualOnly = isManualOnlyAlertSupport(course.alertSupport);
  const isAutomatic = course.monitoringSupport === "AUTOMATIC";
  const isUnconfirmed = isPublicAccessUnverified || (!isManualOnly && !isAutomatic);

  return (
    <p
      className={`course-monitoring-status${isManualOnly ? " is-manual" : ""}${isUnconfirmed ? " is-unconfirmed" : ""}${compact ? " is-compact" : ""}`}
    >
      {isAutomatic ? (
        <CircleCheck aria-hidden="true" size={11} />
      ) : (
        <CircleAlert aria-hidden="true" size={11} />
      )}
      <span>
        <strong>
          {isPublicAccessUnverified
            ? "Public access verification needed"
            : isManualOnly && course.alertSupport
            ? getAlertSupportLabel(course.alertSupport)
            : isAutomatic
              ? "Automatic availability alerts"
              : "Automatic alerts not yet confirmed"}
        </strong>
        {!compact || course.alertSupport === "DIRECT_ONLINE" ? (
          <small>
            {isPublicAccessUnverified
              ? "This possible course is saved for review. Alerts can start after it is verified."
              : isManualOnly && course.alertSupport
              ? `${getAlertSupportDescription(course.alertSupport)} Tee Time Spot does not check this course automatically.`
              : isAutomatic
                ? "Tee Time Spot checks public, signed-out booking availability without entering checkout."
                : "We'll verify whether this course can be checked automatically when your alert starts."}
          </small>
        ) : null}
      </span>
    </p>
  );
}

function CourseResultsMap({
  courses,
  origin
}: {
  courses: CourseCandidate[];
  origin: SearchCoordinates | null;
}) {
  const mapsApiKey = normalizeBrowserGoogleMapsApiKey(
    process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_API_KEY
  );
  const mapsMapId = process.env.NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID?.trim();
  const mapElementId = "course-results-map";
  const [mapLoadError, setMapLoadError] = useState(false);
  const mapCenter = useMemo(() => getCourseMapCenter(courses, origin), [courses, origin]);
  const courseSignature = useMemo(
    () =>
      courses
        .map((course) => `${course.googlePlaceId}:${course.latitude}:${course.longitude}`)
        .join("|"),
    [courses]
  );

  useEffect(() => {
    if (!mapsApiKey || courses.length === 0) {
      return;
    }

    const apiKey = mapsApiKey;
    let isCancelled = false;
    let cleanupMarkers: (() => void) | undefined;
    const handleAuthFailure = () => {
      setMapLoadError(true);
    };
    window.gm_authFailure = handleAuthFailure;

    async function initializeMap() {
      const googleMaps = await loadGoogleMapsApi(apiKey);
      const advancedMarkers = googleMaps.marker;
      const element = document.getElementById(mapElementId);

      if (isCancelled || !element) {
        return;
      }

      const center = { lat: mapCenter.latitude, lng: mapCenter.longitude };
      const mapOptions = {
        center,
        clickableIcons: true,
        fullscreenControl: true,
        mapTypeControl: false,
        streetViewControl: false,
        zoom: 10,
        ...(mapsMapId ? { mapId: mapsMapId } : {})
      };
      const map = new googleMaps.Map(element, {
        ...mapOptions
      });
      const bounds = new googleMaps.LatLngBounds();
      const infoWindow = new googleMaps.InfoWindow({
        ariaLabel: "Course details",
        maxWidth: 340
      });
      const markers: GoogleMapsMarker[] = [];
      const advancedMarkerApi =
        mapsMapId && advancedMarkers?.AdvancedMarkerElement && advancedMarkers.PinElement
          ? advancedMarkers
          : null;

      courses.forEach((course, index) => {
        const position = { lat: course.latitude, lng: course.longitude };
        bounds.extend(position);
        const marker = advancedMarkerApi
          ? createAdvancedCourseMarker(advancedMarkerApi, map, position, course.name, index)
          : new googleMaps.Marker({
              label: String(index + 1),
              map,
              position,
              title: `${index + 1}. ${course.name}`
            });

        marker.addListener?.("click", () => {
          infoWindow.setContent(createCourseMapInfoWindowContent(course));
          infoWindow.open({ anchor: marker, map, shouldFocus: false });
        });
        if (advancedMarkerApi) {
          marker.addListener?.("gmp-click", () => {
            infoWindow.setContent(createCourseMapInfoWindowContent(course));
            infoWindow.open({ anchor: marker, map, shouldFocus: false });
          });
        }
        markers.push(marker);
      });

      if (courses.length > 1) {
        map.fitBounds(bounds);
      }

      cleanupMarkers = () => {
        infoWindow.close();
        markers.forEach((marker) => {
          if ("setMap" in marker) {
            marker.setMap(null);
            return;
          }
          marker.map = null;
        });
      };
    }

    initializeMap().catch(() => {
      // The course list remains usable if Google Maps JS cannot initialize.
      setMapLoadError(true);
    });

    return () => {
      isCancelled = true;
      if (window.gm_authFailure === handleAuthFailure) {
        window.gm_authFailure = undefined;
      }
      cleanupMarkers?.();
    }
  }, [
    courses,
    courseSignature,
    mapCenter.latitude,
    mapCenter.longitude,
    mapsApiKey,
    mapsMapId
  ]);

  if (courses.length === 0) {
    return null;
  }

  return (
    <div className="course-results-map-shell">
      {mapsApiKey && !mapLoadError ? (
        <div
          aria-label={`${courses.length} nearby course locations on Google Maps`}
          className="course-results-map"
          id={mapElementId}
          role="region"
        />
      ) : (
        <CourseFallbackMap
          courses={courses}
          origin={origin}
          reason={
            mapsApiKey
              ? "Google Maps could not load, so this interactive map uses OpenStreetMap."
              : "Google Maps needs a browser API key, so this interactive map uses OpenStreetMap."
          }
        />
      )}
      <div className="course-results-map-count">
        <MapPinned size={16} />
        {courses.length} course locations found
      </div>
    </div>
  );
}

function createAdvancedCourseMarker(
  advancedMarkers: NonNullable<GoogleMapsNamespace["marker"]>,
  map: GoogleMapInstance,
  position: GoogleMapsLatLng,
  courseName: string,
  index: number
) {
  const pin = new advancedMarkers.PinElement({
    background: "#d93025",
    borderColor: "#ffffff",
    glyphColor: "#ffffff",
    glyphText: String(index + 1),
    scale: 1.18
  });
  const marker = new advancedMarkers.AdvancedMarkerElement({
    gmpClickable: true,
    map,
    position,
    title: `${index + 1}. ${courseName}`
  });

  marker.append?.(pin);
  return marker;
}

function CourseFallbackMap({
  courses,
  origin,
  reason
}: {
  courses: CourseCandidate[];
  origin: SearchCoordinates | null;
  reason: string;
}) {
  const mapElementRef = useRef<HTMLDivElement | null>(null);
  const mapInstanceRef = useRef<Leaflet.Map | null>(null);
  const mapCenter = useMemo(() => getCourseMapCenter(courses, origin), [courses, origin]);
  const courseSignature = useMemo(
    () =>
      courses
        .map((course) => `${course.googlePlaceId}:${course.latitude}:${course.longitude}`)
        .join("|"),
    [courses]
  );

  useEffect(() => {
    let isCancelled = false;

    async function initializeFallbackMap() {
      const leaflet = await import("leaflet");

      if (isCancelled || !mapElementRef.current) {
        return;
      }

      mapInstanceRef.current?.remove();
      const map = leaflet
        .map(mapElementRef.current, {
          scrollWheelZoom: false,
          zoomControl: true
        })
        .setView([mapCenter.latitude, mapCenter.longitude], 10);

      leaflet
        .tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
          attribution: "&copy; OpenStreetMap contributors",
          maxZoom: 19
        })
        .addTo(map);

      const bounds = leaflet.latLngBounds([]);
      courses.forEach((course, index) => {
        const position: Leaflet.LatLngTuple = [course.latitude, course.longitude];
        bounds.extend(position);
        leaflet
          .marker(position, {
            icon: leaflet.divIcon({
              className: "fallback-course-marker",
              html: `<span>${index + 1}</span>`,
              iconAnchor: [16, 16],
              iconSize: [32, 32]
            }),
            title: `${index + 1}. ${course.name}`
          })
          .bindPopup(createFallbackMapPopupHtml(course, index))
          .addTo(map);
      });

      if (bounds.isValid()) {
        map.fitBounds(bounds, { padding: [34, 34] });
      }

      mapInstanceRef.current = map;
      window.setTimeout(() => map.invalidateSize(), 0);
    }

    initializeFallbackMap().catch(() => {
      // The course list remains usable if the fallback map cannot initialize.
    });

    return () => {
      isCancelled = true;
      mapInstanceRef.current?.remove();
      mapInstanceRef.current = null;
    };
  }, [courses, courseSignature, mapCenter.latitude, mapCenter.longitude]);

  return (
    <div className="course-fallback-map-shell">
      <div
        aria-label={`${courses.length} nearby course locations on fallback map`}
        className="course-fallback-map"
        ref={mapElementRef}
        role="region"
      />
      <div className="course-fallback-map-note">
        <MapPinned size={16} />
        <span>{reason}</span>
      </div>
    </div>
  );
}

function loadGoogleMapsApi(apiKey: string) {
  if (window.google?.maps?.Map) {
    return Promise.resolve(window.google.maps);
  }

  if (googleMapsLoaderPromise) {
    return googleMapsLoaderPromise;
  }

  googleMapsLoaderPromise = new Promise<GoogleMapsNamespace>((resolve, reject) => {
    window.initTeeTimeSpotGoogleMaps = () => {
      const googleMaps = window.google?.maps;
      if (googleMaps?.Map) {
        resolve(googleMaps);
        return;
      }
      reject(new Error("Google Maps JavaScript API loaded without maps support"));
    };

    const existingScript = document.querySelector<HTMLScriptElement>(
      "script[data-tee-time-spot-google-map]"
    );
    if (existingScript) {
      if (window.google?.maps?.Map) {
        resolve(window.google.maps);
        return;
      }
      existingScript.addEventListener(
        "load",
        () => {
          const googleMaps = window.google?.maps;
          if (googleMaps?.Map) {
            resolve(googleMaps);
            return;
          }
          reject(new Error("Google Maps JavaScript API loaded without maps support"));
        },
        { once: true }
      );
      existingScript.addEventListener("error", () => reject(new Error("Google Maps failed to load")), {
        once: true
      });
      return;
    }

    const script = document.createElement("script");
    script.async = true;
    script.dataset.teeTimeSpotGoogleMap = "true";
    script.defer = true;
    script.onerror = () => reject(new Error("Google Maps failed to load"));
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(
      apiKey
    )}&v=weekly&libraries=marker&loading=async&callback=${GOOGLE_MAPS_SCRIPT_CALLBACK}`;
    document.head.appendChild(script);
  });

  return googleMapsLoaderPromise;
}

function normalizeBrowserGoogleMapsApiKey(apiKey?: string) {
  return apiKey?.replace(/^\uFEFF/, "").trim();
}

function createCourseMapInfoWindowContent(course: CourseCandidate) {
  const container = document.createElement("div");
  container.className = "course-map-info-window";

  const eyebrow = document.createElement("span");
  eyebrow.className = "course-map-info-eyebrow";
  eyebrow.textContent = "Golf course";
  container.appendChild(eyebrow);

  const heading = document.createElement("h3");
  heading.textContent = course.name;
  container.appendChild(heading);

  if (course.address) {
    const address = document.createElement("a");
    address.className = "course-map-info-address";
    address.href = getGoogleMapsSearchUrl(course);
    address.rel = "noreferrer";
    address.target = "_blank";
    address.textContent = course.address;
    container.appendChild(address);
  }

  const details = document.createElement("div");
  details.className = "course-map-info-meta";
  if (course.rating) {
    const rating = document.createElement("span");
    rating.textContent = `${course.rating.toFixed(1)} rating`;
    details.appendChild(rating);
  }
  if (course.distanceMeters !== undefined) {
    const distance = document.createElement("span");
    distance.textContent = formatDistance(course.distanceMeters);
    details.appendChild(distance);
  }
  if (details.childElementCount > 0) {
    container.appendChild(details);
  }

  const actions = document.createElement("div");
  actions.className = "course-map-info-actions";
  const mapsLink = document.createElement("a");
  mapsLink.className = "course-map-info-primary";
  mapsLink.href = getGoogleMapsSearchUrl(course);
  mapsLink.rel = "noreferrer";
  mapsLink.target = "_blank";
  mapsLink.textContent = "Open in Google Maps";
  actions.appendChild(mapsLink);

  if (course.website) {
    const websiteLink = document.createElement("a");
    websiteLink.className = "course-map-info-secondary";
    websiteLink.href = course.website;
    websiteLink.rel = "noreferrer";
    websiteLink.target = "_blank";
    websiteLink.textContent = "Course site";
    actions.appendChild(websiteLink);
  }

  container.appendChild(actions);
  return container;
}

function createFallbackMapPopupHtml(course: CourseCandidate, index: number) {
  const mapsUrl = getGoogleMapsSearchUrl(course);
  const websiteLink = course.website
    ? `<a class="course-map-info-secondary" href="${escapeHtml(course.website)}" target="_blank" rel="noreferrer">Course site</a>`
    : "";
  const rating = course.rating
    ? `<span>${escapeHtml(course.rating.toFixed(1))} rating</span>`
    : "";
  const distance =
    course.distanceMeters !== undefined
      ? `<span>${escapeHtml(formatDistance(course.distanceMeters))}</span>`
      : "";

  return `
    <div class="course-map-info-window">
      <span class="course-map-info-eyebrow">Course ${index + 1}</span>
      <h3>${escapeHtml(course.name)}</h3>
      ${
        course.address
          ? `<a class="course-map-info-address" href="${escapeHtml(mapsUrl)}" target="_blank" rel="noreferrer">${escapeHtml(course.address)}</a>`
          : ""
      }
      ${
        rating || distance
          ? `<div class="course-map-info-meta">${rating}${distance}</div>`
          : ""
      }
      <div class="course-map-info-actions">
        <a class="course-map-info-primary" href="${escapeHtml(mapsUrl)}" target="_blank" rel="noreferrer">Google Maps</a>
        ${websiteLink}
      </div>
    </div>
  `;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function Notice({ id, notice }: { id?: string; notice: Notice }) {
  return (
    <div
      className={`alert alert-${notice.type}`}
      id={id}
      role={notice.type === "error" ? "alert" : "status"}
    >
      {notice.message}
    </div>
  );
}

async function readApiError(response: Response, fallback: string) {
  try {
    const body = (await response.json()) as { error?: unknown };
    return typeof body.error === "string" && body.error.trim() ? body.error : fallback;
  } catch {
    return fallback;
  }
}

function CourseHeadlinePrice({
  estimate,
  preferredHoleCounts
}: {
  estimate?: CoursePriceEstimate;
  preferredHoleCounts?: readonly number[];
}) {
  const headlinePrice = getHeadlineCoursePrice(estimate, preferredHoleCounts);
  if (!headlinePrice) return null;

  const observedLabel = estimate
    ? new Date(estimate.observedAt).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric"
      })
    : undefined;

  return (
    <span
      aria-label={`Estimated ${headlinePrice.holes}-hole course cost ${formatAccessiblePriceRange(headlinePrice.range)}`}
      className="figma-course-pill is-price"
      title={observedLabel ? `Based on official ${headlinePrice.holes}-hole rates observed through ${observedLabel}` : undefined}
    >
      <span aria-hidden="true">·</span> {formatPriceRange(headlinePrice.range)}
    </span>
  );
}

function formatPriceRange(range: CoursePriceRange) {
  const minimum = formatUsd(range.minPriceCents);
  const maximum = formatUsd(range.maxPriceCents);
  return minimum === maximum ? minimum : `${minimum}–${maximum}`;
}

function formatAccessiblePriceRange(range: CoursePriceRange) {
  const minimum = formatUsd(range.minPriceCents);
  const maximum = formatUsd(range.maxPriceCents);
  return minimum === maximum ? minimum : `${minimum} to ${maximum}`;
}

function formatUsd(priceCents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: priceCents % 100 === 0 ? 0 : 2
  }).format(priceCents / 100);
}

function sortCoursesByDistance(courses: CourseCandidate[]) {
  return [...courses].sort(
    (a, b) =>
      (a.distanceMeters ?? Number.MAX_SAFE_INTEGER) -
      (b.distanceMeters ?? Number.MAX_SAFE_INTEGER)
  );
}

function formatDistance(distanceMeters: number) {
  const miles = distanceMeters / 1609.344;
  return `${miles < 10 ? miles.toFixed(1) : Math.round(miles)} mi`;
}

function getCourseMapCenter(courses: CourseCandidate[], origin: SearchCoordinates | null) {
  if (origin) {
    return origin;
  }

  if (courses.length === 0) {
    return { latitude: 41.242, longitude: -73.209 };
  }

  return {
    latitude: courses.reduce((sum, course) => sum + course.latitude, 0) / courses.length,
    longitude: courses.reduce((sum, course) => sum + course.longitude, 0) / courses.length
  };
}

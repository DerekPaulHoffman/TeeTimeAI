import { auth, currentUser } from "@clerk/nextjs/server";

import { hasClerkConfig } from "@/lib/env";

import { isOperatorEmail, normalizeOperatorEmail } from "./access";

export type CurrentOperator = {
  clerkUserId: string;
  email: string;
};

export async function getCurrentOperator(): Promise<CurrentOperator | null> {
  if (!hasClerkConfig()) {
    return null;
  }

  const { userId } = await auth();
  if (!userId) {
    return null;
  }

  const user = await currentUser();
  const primaryEmail = user?.primaryEmailAddress?.emailAddress;
  if (!isOperatorEmail(primaryEmail)) {
    return null;
  }

  return {
    clerkUserId: userId,
    email: normalizeOperatorEmail(primaryEmail)
  };
}

import { auth, currentUser } from "@clerk/nextjs/server";

import { upsertClerkUser } from "@/lib/users/service";

export async function getRequiredAppUser() {
  const { userId } = await auth();
  if (!userId) {
    throw new Error("Unauthorized");
  }

  const clerkUser = await currentUser();
  const email = clerkUser?.primaryEmailAddress?.emailAddress;
  if (!email) {
    throw new Error("Current Clerk user does not have a primary email");
  }

  return upsertClerkUser({ clerkUserId: userId, email });
}

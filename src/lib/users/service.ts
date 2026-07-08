import { prisma } from "@/lib/prisma";

export function upsertClerkUser(input: { clerkUserId: string; email: string }) {
  return prisma.user.upsert({
    where: { clerkUserId: input.clerkUserId },
    update: { email: input.email },
    create: {
      clerkUserId: input.clerkUserId,
      email: input.email
    }
  });
}

export function upsertGuestUser(email: string) {
  const normalizedEmail = email.trim().toLowerCase();

  return prisma.user.upsert({
    where: { clerkUserId: guestUserKey(normalizedEmail) },
    update: { email: normalizedEmail },
    create: {
      clerkUserId: guestUserKey(normalizedEmail),
      email: normalizedEmail
    }
  });
}

function guestUserKey(email: string) {
  return `guest:${email}`;
}

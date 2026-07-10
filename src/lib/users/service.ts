import { prisma } from "@/lib/prisma";

export function upsertClerkUser(input: { clerkUserId: string; email: string }) {
  const normalizedEmail = normalizeEmail(input.email);

  return prisma.$transaction(async (transaction) => {
    const user = await transaction.user.upsert({
      where: { clerkUserId: input.clerkUserId },
      update: { email: normalizedEmail },
      create: {
        clerkUserId: input.clerkUserId,
        email: normalizedEmail
      }
    });
    const guestUser = await transaction.user.findUnique({
      where: { clerkUserId: guestUserKey(normalizedEmail) },
      select: { id: true }
    });

    if (guestUser && guestUser.id !== user.id) {
      await transaction.teeSearch.updateMany({
        where: { userId: guestUser.id },
        data: { userId: user.id }
      });
    }

    return user;
  });
}

export function upsertGuestUser(email: string) {
  const normalizedEmail = normalizeEmail(email);

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

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

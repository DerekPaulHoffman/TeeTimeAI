import { NextResponse } from "next/server";

import { getCurrentOperator } from "@/lib/operator/auth";

export const dynamic = "force-dynamic";

export async function GET() {
  const operator = await getCurrentOperator();

  return NextResponse.json(
    { operator: Boolean(operator) },
    {
      headers: {
        "Cache-Control": "private, no-store"
      }
    }
  );
}

export function GET() {
  return new Response("Redirecting to /icon.svg", {
    status: 308,
    headers: {
      location: "/icon.svg"
    }
  });
}

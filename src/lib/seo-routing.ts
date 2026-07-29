export const canonicalHostRedirects = [
  {
    source: "/:path*",
    has: [
      {
        type: "host" as const,
        value: "www.teetimespot.com"
      }
    ],
    destination: "https://teetimespot.com/:path*",
    permanent: true
  }
];

const CONFETTI_COLORS = ["#0f5132", "#2f7d57", "#f4c95d", "#f28c45", "#ffffff"];
const CONFETTI_PARTICLE_COUNT = 36;
const CONFETTI_LIFETIME_MS = 2600;

export function fireAlertCreatedConfetti() {
  if (
    typeof document === "undefined" ||
    typeof window === "undefined" ||
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  ) {
    return;
  }

  document.querySelectorAll("[data-alert-confetti]").forEach((element) => element.remove());

  const layer = document.createElement("div");
  layer.className = "alert-created-confetti";
  layer.dataset.alertConfetti = "alert-created";
  layer.setAttribute("aria-hidden", "true");

  for (let index = 0; index < CONFETTI_PARTICLE_COUNT; index += 1) {
    const fromLeft = index % 2 === 0;
    const distance = 24 + ((index * 17) % 58);
    const particle = document.createElement("span");
    const isEmoji = index % 9 === 0;

    particle.className = isEmoji
      ? "alert-created-confetti-particle alert-created-confetti-emoji"
      : "alert-created-confetti-particle";
    particle.style.left = fromLeft ? "4vw" : "96vw";
    particle.style.setProperty("--confetti-color", CONFETTI_COLORS[index % CONFETTI_COLORS.length]);
    particle.style.setProperty("--confetti-delay", `${(index % 6) * 24}ms`);
    particle.style.setProperty("--confetti-duration", `${1900 + (index % 5) * 110}ms`);
    particle.style.setProperty("--confetti-peak-x", `${fromLeft ? distance : -distance}vw`);
    particle.style.setProperty("--confetti-peak-y", `${-(54 + ((index * 11) % 34))}vh`);
    particle.style.setProperty(
      "--confetti-end-x",
      `${fromLeft ? distance + 10 : -(distance + 10)}vw`
    );
    particle.style.setProperty("--confetti-spin", `${fromLeft ? 540 : -540}deg`);

    if (isEmoji) {
      particle.textContent = index % 18 === 0 ? "⛳" : "🎉";
    }

    layer.appendChild(particle);
  }

  document.body.appendChild(layer);
  window.setTimeout(() => layer.remove(), CONFETTI_LIFETIME_MS);
}

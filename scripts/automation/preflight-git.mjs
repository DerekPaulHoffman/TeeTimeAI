export function getCheckoutMode(branch) {
  if (branch === "main") {
    return "main";
  }

  if (branch === "HEAD") {
    return "detached";
  }

  return null;
}

export function getPushRef(checkoutMode) {
  return checkoutMode === "detached" ? "HEAD:main" : "main";
}

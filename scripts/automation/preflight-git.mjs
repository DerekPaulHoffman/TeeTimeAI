export function getCheckoutMode(branch) {
  if (branch === "main" || branch === "HEAD") {
    return null;
  }

  return "thread_branch";
}

export function getPushRef(checkoutMode) {
  return checkoutMode === "thread_branch" ? "HEAD:main" : null;
}

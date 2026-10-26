const status = document.querySelector("#purchase-status");

document.querySelectorAll(".checkout").forEach((button) => {
  button.addEventListener("click", async () => {
    button.disabled = true;
    const original = button.textContent;
    button.textContent = "Opening secure checkout…";
    status.textContent = "";
    try {
      const response = await fetch("/.netlify/functions/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tier: button.dataset.tier })
      });
      const result = await response.json();
      if (!response.ok || !result.checkoutUrl) throw new Error(result.error || "checkout_unavailable");
      window.location.assign(result.checkoutUrl);
    } catch (error) {
      status.textContent = error.message === "checkout_not_configured"
        ? "Official checkout is being configured. You can still run the 30-day evaluation locally today."
        : "Secure checkout could not start. Please try again shortly.";
      button.disabled = false;
      button.textContent = original;
    }
  });
});

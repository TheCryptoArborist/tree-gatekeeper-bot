const tg = window.Telegram?.WebApp;
const form = document.querySelector("#verifyForm");
const walletInput = document.querySelector("#wallet");
const button = document.querySelector("#verifyButton");
const result = document.querySelector("#result");
const statusText = document.querySelector("#statusText");
const nftreeCount = document.querySelector("#nftreeCount");
const collectionType = document.querySelector("#collectionType");
const warningText = document.querySelector("#warningText");
const joinLink = document.querySelector("#joinLink");

tg?.ready();
tg?.expand();

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  setBusy(true);
  showResult({ message: "Checking NFTree ownership...", eligible: true });

  try {
    const response = await fetch("/api/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        wallet: walletInput.value.trim(),
        initData: tg?.initData ?? ""
      })
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.error || "Verification failed.");

    renderVerification(payload);
  } catch (error) {
    showResult({
      message: error.message,
      eligible: false,
      nftreeCount: "-"
    });
  } finally {
    setBusy(false);
  }
});

function renderVerification(payload) {
  showResult({
    message: payload.eligible ? "Verified for whale chat" : "Not eligible yet",
    eligible: payload.eligible,
    nftreeCount: `${payload.nftreeCount ?? 0}`,
    warnings: payload.warnings,
    inviteUrl: payload.inviteUrl
  });
}

function showResult(payload) {
  result.classList.remove("hidden");
  statusText.textContent = payload.message;
  statusText.classList.toggle("fail", !payload.eligible);
  nftreeCount.textContent = payload.nftreeCount ?? "";
  collectionType.textContent = "0xf6c6...::collection::NFT";

  const warnings = payload.warnings ?? [];
  warningText.textContent = warnings.length ? `Source warning: ${warnings.join("; ")}` : "";
  warningText.classList.toggle("hidden", !warnings.length);

  if (payload.eligible && payload.inviteUrl) {
    joinLink.href = payload.inviteUrl;
    joinLink.classList.remove("hidden");
  } else {
    joinLink.classList.add("hidden");
  }
}

function setBusy(isBusy) {
  button.disabled = isBusy;
  button.textContent = isBusy ? "Checking" : "Verify";
}

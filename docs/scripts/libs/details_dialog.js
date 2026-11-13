// A pop-up with a heading and some lines of text (line breaks kept), and a Close button.
export function showDetails(headline, text) {
    const dialog = document.createElement("mdui-dialog");
    dialog.headline = headline;
    dialog.closeOnOverlayClick = true;

    const body = document.createElement("div");
    body.style.whiteSpace = "pre-line";
    body.textContent = text;
    dialog.appendChild(body);

    const close = document.createElement("mdui-button");
    close.slot = "action";
    close.variant = "text";
    close.textContent = "Close";
    close.addEventListener("click", () => { dialog.open = false; });
    dialog.appendChild(close);

    dialog.addEventListener("closed", () => dialog.remove());
    document.body.appendChild(dialog);
    dialog.open = true;
}

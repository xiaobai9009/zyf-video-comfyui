import { zyfAddStylesheet, zyfGetUrl } from "../utils.js";

zyfAddStylesheet(zyfGetUrl("./spinner.css", import.meta.url));

export function createZYFSpinner() {
	const div = document.createElement("div");
	div.innerHTML = `<div class="zyf-lds-ring"><div></div><div></div><div></div><div></div></div>`;
	return div.firstElementChild;
}

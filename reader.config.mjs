import { inhalt } from "./reader.contents.mjs";

export default {
  inhalt,
  htmlRoot: "../MEW_BRIEF",
  imageRoots: [
    "../cache_images{volume}",
    "../cache_images_zh{volume}",
    "../cache_images_zhwj{volume}"
  ],
  imagePattern: "page_{page:04}.png"
};

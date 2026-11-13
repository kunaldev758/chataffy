const cheerio = require("cheerio");
const crypto = require("crypto");

function newNodeId() {
  return crypto.randomBytes(8).toString("hex");
}

function textNode(text, decorations = []) {
  return {
    type: "TEXT",
    id: "",
    nodes: [],
    textData: {
      text: text || "",
      decorations: decorations || [],
    },
  };
}

function paragraphNode(children, paragraphData = {}) {
  return {
    type: "PARAGRAPH",
    id: newNodeId(),
    nodes: children.length ? children : [textNode("")],
    paragraphData,
  };
}

function headingNode(level, children) {
  return {
    type: "HEADING",
    id: newNodeId(),
    nodes: children.length ? children : [textNode("")],
    headingData: {
      level: Math.min(Math.max(Number(level) || 2, 1), 6),
      textStyle: { textAlignment: "AUTO" },
    },
  };
}

function bulletListNode(items) {
  return {
    type: "BULLETED_LIST",
    id: newNodeId(),
    nodes: items,
    bulletedListData: {},
  };
}

function listItemNode(children) {
  return {
    type: "LIST_ITEM",
    id: newNodeId(),
    nodes: [paragraphNode(children)],
    listItemData: {},
  };
}

/**
 * Convert inline HTML (strong/em/a/br/text) into TEXT nodes with decorations.
 */
function inlineToTextNodes(el, $) {
  const nodes = [];

  function walk(node, decorations) {
    if (node.type === "text") {
      const value = node.data || "";
      if (value) nodes.push(textNode(value, decorations.slice()));
      return;
    }
    if (node.type !== "tag") return;

    const name = (node.name || "").toLowerCase();
    if (name === "br") {
      nodes.push(textNode("\n", decorations.slice()));
      return;
    }

    const next = decorations.slice();
    if (name === "strong" || name === "b") {
      next.push({ type: "BOLD", fontWeightValue: 700 });
    } else if (name === "em" || name === "i") {
      next.push({ type: "ITALIC", italicData: true });
    } else if (name === "u") {
      next.push({ type: "UNDERLINE", underlineData: true });
    } else if (name === "a") {
      const href = $(node).attr("href");
      if (href) {
        next.push({
          type: "LINK",
          linkData: {
            link: {
              url: href,
              target: "_BLANK",
            },
          },
        });
      }
    }

    (node.children || []).forEach((child) => walk(child, next));
  }

  (el.children || []).forEach((child) => walk(child, []));
  return nodes.length ? nodes : [textNode($(el).text() || "")];
}

/**
 * Convert HTML blog content into Wix Blog richContent (Ricos) format.
 */
function htmlToWixRichContent(html) {
  const safe = String(html || "").trim();
  if (!safe) {
    return {
      nodes: [paragraphNode([textNode("")])],
    };
  }

  const $ = cheerio.load(`<div id="wix-root">${safe}</div>`);
  const root = $("#wix-root").get(0);
  const nodes = [];

  function pushBlockFromElement(el) {
    const name = (el.name || "").toLowerCase();

    if (/^h[1-6]$/.test(name)) {
      const level = Number(name.slice(1));
      nodes.push(headingNode(level, inlineToTextNodes(el, $)));
      return;
    }

    if (name === "p" || name === "div" || name === "section") {
      const text = $(el).text().trim();
      if (!text && !$(el).find("img,br").length) return;
      nodes.push(paragraphNode(inlineToTextNodes(el, $)));
      return;
    }

    if (name === "ul" || name === "ol") {
      const items = [];
      $(el)
        .children("li")
        .each((_, li) => {
          items.push(listItemNode(inlineToTextNodes(li, $)));
        });
      if (items.length) nodes.push(bulletListNode(items));
      return;
    }

    if (name === "blockquote") {
      nodes.push(
        paragraphNode(inlineToTextNodes(el, $), {
          textStyle: { textAlignment: "AUTO" },
        })
      );
      return;
    }

    // Unknown block: flatten children or treat as paragraph
    if (el.children && el.children.length) {
      el.children.forEach((child) => {
        if (child.type === "tag") pushBlockFromElement(child);
        else if (child.type === "text" && String(child.data || "").trim()) {
          nodes.push(paragraphNode([textNode(String(child.data).trim())]));
        }
      });
    }
  }

  (root.children || []).forEach((child) => {
    if (child.type === "tag") {
      pushBlockFromElement(child);
    } else if (child.type === "text" && String(child.data || "").trim()) {
      nodes.push(paragraphNode([textNode(String(child.data).trim())]));
    }
  });

  if (!nodes.length) {
    const plain = $.text().trim();
    nodes.push(paragraphNode([textNode(plain || "")]));
  }

  return { nodes };
}

module.exports = {
  htmlToWixRichContent,
};

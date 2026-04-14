import Anthropic from "@anthropic-ai/sdk";

export const tools: Anthropic.Tool[] = [
  {
    name: "navigate",
    description:
      "Navigate the browser to a URL. Use this to open websites. The page state (text content and interactive elements) will be returned automatically.",
    input_schema: {
      type: "object" as const,
      properties: {
        url: {
          type: "string",
          description:
            "The URL to navigate to (e.g. 'https://google.com'). Protocol is added automatically if missing.",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "click",
    description:
      "Click on an interactive element by its number from the page state. After clicking, check the result to see if the page changed.",
    input_schema: {
      type: "object" as const,
      properties: {
        element_id: {
          type: "number",
          description:
            "The number of the element to click (from the interactive elements list in get_page_state output)",
        },
      },
      required: ["element_id"],
    },
  },
  {
    name: "type_text",
    description:
      "Type text into an input field or textarea by its element number. By default clears the field first.",
    input_schema: {
      type: "object" as const,
      properties: {
        element_id: {
          type: "number",
          description: "The number of the input element to type into",
        },
        text: {
          type: "string",
          description: "The text to type",
        },
        clear_first: {
          type: "boolean",
          description:
            "Whether to clear the field before typing (default: true)",
        },
      },
      required: ["element_id", "text"],
    },
  },
  {
    name: "hover",
    description:
      "Hover over an element by its number. Useful for revealing dropdown menus, tooltips, or hidden elements.",
    input_schema: {
      type: "object" as const,
      properties: {
        element_id: {
          type: "number",
          description: "The number of the element to hover over",
        },
      },
      required: ["element_id"],
    },
  },
  {
    name: "press_key",
    description:
      "Press a keyboard key or key combination. Common keys: Enter, Escape, Tab, ArrowDown, ArrowUp, Backspace, Delete, Space. Combinations: Control+A, Control+C, Control+V.",
    input_schema: {
      type: "object" as const,
      properties: {
        key: {
          type: "string",
          description: "The key to press (e.g. 'Enter', 'Tab', 'Control+A')",
        },
      },
      required: ["key"],
    },
  },
  {
    name: "select_option",
    description:
      "Select an option from a <select> dropdown element by its number.",
    input_schema: {
      type: "object" as const,
      properties: {
        element_id: {
          type: "number",
          description: "The number of the select element",
        },
        value: {
          type: "string",
          description:
            "The visible text label of the option to select, or its value attribute",
        },
      },
      required: ["element_id", "value"],
    },
  },
  {
    name: "scroll",
    description: "Scroll the page up or down to reveal more content.",
    input_schema: {
      type: "object" as const,
      properties: {
        direction: {
          type: "string",
          enum: ["up", "down"],
          description: "Direction to scroll",
        },
        amount: {
          type: "number",
          description: "Pixels to scroll (default: 600)",
        },
      },
      required: ["direction"],
    },
  },
  {
    name: "get_page_state",
    description:
      "Get the current page state: URL, title, visible text content, and a numbered list of all interactive elements. ALWAYS call this after actions that change the page content (clicks that open menus, form submissions, etc.) to get fresh element numbers.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "screenshot",
    description:
      "Take a screenshot of the current browser viewport. Use this when you need to visually verify what the page looks like, understand complex layouts, or when the text content does not provide enough information. Returns the image for visual analysis.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "go_back",
    description: "Go back to the previous page in browser history.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "wait",
    description:
      "Wait for a specified time. Useful when waiting for dynamic content, animations, or page transitions to complete.",
    input_schema: {
      type: "object" as const,
      properties: {
        ms: {
          type: "number",
          description: "Milliseconds to wait (default: 2000, max: 10000)",
        },
      },
      required: [],
    },
  },
  {
    name: "switch_tab",
    description:
      "Switch to a different browser tab by its index. Returns a list of all open tabs first.",
    input_schema: {
      type: "object" as const,
      properties: {
        tab_index: {
          type: "number",
          description: "The 0-based index of the tab to switch to",
        },
      },
      required: ["tab_index"],
    },
  },
  {
    name: "ask_user",
    description:
      "Ask the user a question when you need additional information, clarification, or a decision to proceed with the task. The user will see your question in the terminal and can type a response.",
    input_schema: {
      type: "object" as const,
      properties: {
        question: {
          type: "string",
          description: "The question to ask the user",
        },
      },
      required: ["question"],
    },
  },
  {
    name: "task_complete",
    description:
      "Signal that the task has been completed. Call this when you have finished the user's request. Provide a clear summary of what was accomplished.",
    input_schema: {
      type: "object" as const,
      properties: {
        summary: {
          type: "string",
          description:
            "A summary of what was accomplished, including any important results or information gathered",
        },
      },
      required: ["summary"],
    },
  },
];

import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, Editor, Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { EditorTheme } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { callHeader, textComponent, treeLines, type RenderContext } from "./shared/tool-render-style.ts";

interface RawOption {
	label: string;
	description?: string;
	value?: string;
}

interface RawQuestion {
	id?: string;
	label?: string;
	prompt: string;
	options: RawOption[];
	allowOther?: boolean;
	multiple?: boolean;
}

interface AskUserQuestionParams {
	questions: RawQuestion[];
}

interface QuestionOption {
	value: string;
	label: string;
	description?: string;
}

type RenderOption = QuestionOption & { isOther?: boolean };

interface Question {
	id: string;
	label: string;
	prompt: string;
	options: QuestionOption[];
	allowOther: boolean;
	multiple: boolean;
}

interface AnswerChoice {
	value: string;
	label: string;
	wasCustom: boolean;
	index?: number;
}

interface Answer {
	id: string;
	value: string;
	label: string;
	wasCustom: boolean;
	index?: number;
	multiple: boolean;
	choices: AnswerChoice[];
	values: string[];
	labels: string[];
	indices: number[];
}

interface AskUserQuestionDetails {
	questions: Question[];
	answers: Answer[];
	cancelled: boolean;
}

const INLINE_INPUT_MAX_WIDTH = 56;
const INLINE_INPUT_PROMPT = "> ";
const INLINE_INPUT_CONTINUATION = "  ";
const inlineSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

type InlineInput = {
	getValue(): string;
	focused: boolean;
	cursor?: number;
};

function getInlineInputWidth(lineWidth: number) {
	const availableWidth = Math.max(1, lineWidth - 6); // Account for inline indentation.
	return Math.min(INLINE_INPUT_MAX_WIDTH, availableWidth);
}

function getInlineInputCursor(input: InlineInput) {
	const value = input.getValue();
	const cursor = input.cursor;
	if (typeof cursor !== "number" || !Number.isFinite(cursor)) return value.length;
	return Math.max(0, Math.min(value.length, cursor));
}

function getEditorCursorOffset(editor: Editor) {
	const lines = editor.getLines();
	const cursor = editor.getCursor();
	const safeLine = Math.max(0, Math.min(lines.length - 1, cursor.line));
	let offset = 0;
	for (let i = 0; i < safeLine; i++) offset += (lines[i]?.length ?? 0) + 1;
	const safeCol = Math.max(0, Math.min(lines[safeLine]?.length ?? 0, cursor.col));
	return Math.max(0, Math.min(editor.getText().length, offset + safeCol));
}

function makeInlineInput(editor: Editor): InlineInput {
	return {
		getValue: () => editor.getText(),
		get focused() {
			return editor.focused;
		},
		get cursor() {
			return getEditorCursorOffset(editor);
		},
	};
}

function firstGrapheme(text: string) {
	return Array.from(inlineSegmenter.segment(text))[0]?.segment ?? "";
}

function renderCursor(text: string, cursorOffset: number, focused: boolean) {
	const safeOffset = Math.max(0, Math.min(text.length, cursorOffset));
	const before = text.slice(0, safeOffset);
	const after = text.slice(safeOffset);
	const atCursor = firstGrapheme(after);
	const marker = focused ? CURSOR_MARKER : "";

	if (!atCursor) return `${before}${marker}\x1b[7m \x1b[27m`;
	return `${before}${marker}\x1b[7m${atCursor}\x1b[27m${after.slice(atCursor.length)}`;
}

interface InlineLine {
	start: number;
	end: number;
	text: string;
	isLineEnd: boolean;
}

function wrapInlineParagraph(value: string, width: number, offset: number) {
	const contentWidth = Math.max(1, width);
	if (!value) return [{ start: offset, end: offset, text: "", isLineEnd: true }];

	const segments = Array.from(inlineSegmenter.segment(value));
	const lines: InlineLine[] = [];
	let lineStart = 0;
	let lineWidth = 0;
	let lastWhitespaceEnd = -1;

	for (let i = 0; i < segments.length;) {
		const segment = segments[i];
		const segmentWidth = visibleWidth(segment.segment);

		if (lineWidth > 0 && lineWidth + segmentWidth > contentWidth) {
			const lineEnd = lastWhitespaceEnd > lineStart ? lastWhitespaceEnd : segment.index;
			lines.push({ start: offset + lineStart, end: offset + lineEnd, text: value.slice(lineStart, lineEnd), isLineEnd: false });
			lineStart = lineEnd;
			lineWidth = visibleWidth(value.slice(lineStart, segment.index));
			lastWhitespaceEnd = -1;
			continue;
		}

		lineWidth += segmentWidth;
		if (/\s/.test(segment.segment)) lastWhitespaceEnd = segment.index + segment.segment.length;
		i++;
	}

	lines.push({ start: offset + lineStart, end: offset + value.length, text: value.slice(lineStart), isLineEnd: true });
	return lines;
}

function wrapInlineInputValue(value: string, width: number) {
	const contentWidth = Math.max(1, width);
	if (!value) return [{ start: 0, end: 0, text: "", isLineEnd: true }];

	const lines: InlineLine[] = [];
	const paragraphs = value.split("\n");
	let offset = 0;

	for (let index = 0; index < paragraphs.length; index++) {
		const paragraph = paragraphs[index];
		lines.push(...wrapInlineParagraph(paragraph, contentWidth, offset));
		offset += paragraph.length;
		if (index < paragraphs.length - 1) offset += 1;
	}

	return lines;
}

function renderInlineInput(input: InlineInput, width: number) {
	const inputWidth = Math.max(INLINE_INPUT_PROMPT.length + 1, width);
	// Reserve one column for the cursor when it is at the end of a visual line.
	const contentWidth = Math.max(1, inputWidth - INLINE_INPUT_PROMPT.length - 1);
	const value = input.getValue();
	const cursor = getInlineInputCursor(input);
	const wrappedLines = wrapInlineInputValue(value, contentWidth);

	return wrappedLines.map((line, index) => {
		const hasCursor = cursor >= line.start && (cursor < line.end || (line.isLineEnd && cursor === line.end));
		const content = hasCursor ? renderCursor(line.text, cursor - line.start, input.focused) : line.text;
		const prefix = index === 0 ? INLINE_INPUT_PROMPT : INLINE_INPUT_CONTINUATION;
		return `${prefix}${content}`;
	});
}

const OptionSchema = Type.Object({
	label: Type.String({ description: "Display label for this option" }),
	description: Type.Optional(Type.String({ description: "Optional short helper text shown under the option" })),
	value: Type.Optional(Type.String({ description: "Machine-readable value. Defaults to label." })),
});

const QuestionSchema = Type.Object({
	id: Type.Optional(Type.String({ description: "Stable answer id. Defaults to q1, q2, ..." })),
	label: Type.Optional(Type.String({ description: "Short tab label, e.g. Angle, Audience, Scope" })),
	prompt: Type.String({ description: "Question text to show the user" }),
	options: Type.Array(OptionSchema, { description: "Options the user can choose from" }),
	allowOther: Type.Optional(Type.Boolean({ description: "Whether to include a 'Type something.' option. Defaults to true." })),
	multiple: Type.Optional(Type.Boolean({ description: "Whether the user can select multiple options for this question. Defaults to false." })),
});

const AskUserQuestionSchema = Type.Object({
	questions: Type.Array(QuestionSchema, {
		description: "One or more questions to ask. Use one item for a simple picker, multiple items for a tabbed form.",
		minItems: 1,
	}),
});

function normalizeQuestions(rawQuestions: RawQuestion[]): Question[] {
	const seenIds = new Map<string, number>();

	return rawQuestions.map((raw, index) => {
		const fallbackId = `q${index + 1}`;
		const baseId = (raw.id || raw.label || fallbackId)
			.toLowerCase()
			.trim()
			.replace(/[^a-z0-9_-]+/g, "_")
			.replace(/^_+|_+$/g, "") || fallbackId;
		const count = seenIds.get(baseId) ?? 0;
		seenIds.set(baseId, count + 1);
		const id = count === 0 ? baseId : `${baseId}_${count + 1}`;

		return {
			id,
			label: raw.label?.trim() || raw.id?.trim() || `Q${index + 1}`,
			prompt: raw.prompt,
			options: raw.options.map((option) => ({
				label: option.label,
				value: option.value ?? option.label,
				description: option.description,
			})),
			allowOther: raw.allowOther !== false,
			multiple: raw.multiple === true,
		};
	});
}

function makeOptions(question: Question): RenderOption[] {
	const options: RenderOption[] = [...question.options];
	if (question.allowOther) {
		options.push({ value: "__custom__", label: "Type something.", isOther: true });
	}
	return options;
}

function sortChoices(choices: AnswerChoice[]) {
	return [...choices].sort((a, b) => {
		if (a.index !== undefined && b.index !== undefined) return a.index - b.index;
		if (a.index !== undefined) return -1;
		if (b.index !== undefined) return 1;
		return a.label.localeCompare(b.label);
	});
}

function makeAnswer(question: Question, choices: AnswerChoice[]): Answer | undefined {
	const sorted = sortChoices(choices);
	if (sorted.length === 0) return undefined;

	return {
		id: question.id,
		value: sorted.map((choice) => choice.value).join(", "),
		label: sorted.map((choice) => choice.label).join(", "),
		wasCustom: sorted.some((choice) => choice.wasCustom),
		index: sorted.length === 1 ? sorted[0].index : undefined,
		multiple: question.multiple,
		choices: sorted,
		values: sorted.map((choice) => choice.value),
		labels: sorted.map((choice) => choice.label),
		indices: sorted.flatMap((choice) => (choice.index === undefined ? [] : [choice.index])),
	};
}

function formatChoice(choice: AnswerChoice) {
	return choice.wasCustom ? `wrote: ${choice.label}` : `${choice.index}. ${choice.label}`;
}

function formatAnswerLines(result: AskUserQuestionDetails) {
	return result.answers.map((answer) => {
		const question = result.questions.find((q) => q.id === answer.id);
		const label = question?.label ?? answer.id;
		if (answer.multiple) return `${label}: user selected: ${answer.choices.map(formatChoice).join("; ")}`;
		const choice = answer.choices[0];
		if (!choice) return `${label}: ${answer.label}`;
		if (choice.wasCustom) return `${label}: user wrote: ${choice.label}`;
		return `${label}: user selected: ${choice.index}. ${choice.label}`;
	});
}


async function showAskUserQuestionForm(
  ctx: ExtensionContext,
  questions: Question[],
): Promise<AskUserQuestionDetails> {
  const showTabs = questions.length > 1 || questions.some((question) => question.multiple);
  const submitTab = questions.length;
  const totalTabs = questions.length + (showTabs ? 1 : 0);

  return ctx.ui.custom<AskUserQuestionDetails>((tui, theme, _keybindings, done) => {
    let currentTab = 0;
    let optionIndex = 0;
    let inputMode = false;
    let inputQuestionId: string | null = null;
    let inputError: string | undefined;
    let cachedLines: string[] | undefined;
    let focused = false;
    const answers = new Map<string, Answer>();
    const editorTheme: EditorTheme = {
      borderColor: (s) => theme.fg("accent", s),
      selectList: {
        selectedPrefix: (t) => theme.fg("accent", t),
        selectedText: (t) => theme.fg("accent", t),
        description: (t) => theme.fg("muted", t),
        scrollInfo: (t) => theme.fg("dim", t),
        noMatch: (t) => theme.fg("warning", t),
      },
    };
    const answerEditor = new Editor(tui, editorTheme);

    function syncEditorFocus() {
      answerEditor.focused = focused && inputMode;
    }

    function refresh() {
      cachedLines = undefined;
      tui.requestRender();
    }

    function currentQuestion(): Question | undefined {
      return questions[currentTab];
    }

    function currentOptions(): RenderOption[] {
      const question = currentQuestion();
      return question ? makeOptions(question) : [];
    }

    function choicesFor(question: Question) {
      return answers.get(question.id)?.choices ?? [];
    }

    function customChoiceFor(question: Question) {
      return choicesFor(question).find((choice) => choice.wasCustom);
    }

    function hasOptionChoice(question: Question, optionIndex: number) {
      return choicesFor(question).some((choice) => !choice.wasCustom && choice.index === optionIndex + 1);
    }

    function setChoices(question: Question, choices: AnswerChoice[]) {
      const answer = makeAnswer(question, choices);
      if (answer) answers.set(question.id, answer);
      else answers.delete(question.id);
    }

    function allAnswered() {
      return questions.every((question) => answers.has(question.id));
    }

    function setTab(nextTab: number) {
      if (!showTabs) return;
      currentTab = (nextTab + totalTabs) % totalTabs;
      const question = currentQuestion();
      const answer = question ? answers.get(question.id) : undefined;
      optionIndex = answer?.index ? Math.max(0, answer.index - 1) : 0;
      inputMode = false;
      inputQuestionId = null;
      inputError = undefined;
      answerEditor.setText("");
      syncEditorFocus();
      refresh();
    }

    function submit(cancelled: boolean) {
      const orderedAnswers = questions
        .map((question) => answers.get(question.id))
        .filter((answer): answer is Answer => answer !== undefined);
      done({ questions, answers: orderedAnswers, cancelled });
    }

    function advanceAfterAnswer() {
      if (!showTabs) {
        submit(false);
        return;
      }
      if (currentTab < questions.length - 1) setTab(currentTab + 1);
      else setTab(submitTab);
    }

    function closeInlineInput() {
      inputMode = false;
      inputQuestionId = null;
      inputError = undefined;
      answerEditor.setText("");
      syncEditorFocus();
      refresh();
    }

    function openInlineInput(question: Question) {
      inputMode = true;
      inputQuestionId = question.id;
      inputError = undefined;
      answerEditor.setText(customChoiceFor(question)?.label ?? "");
      syncEditorFocus();
      refresh();
    }

    function saveCustomAnswer(submittedText?: string) {
      if (!inputQuestionId) return;
      const question = questions.find((q) => q.id === inputQuestionId);
      if (!question) return;

      // Editor.submitValue() clears its buffer before invoking onSubmit and passes the
      // submitted text as an argument, so prefer that over reading the (now empty) editor.
      const trimmed = (submittedText ?? answerEditor.getExpandedText()).trim();
      if (!trimmed) {
        inputError = "Type an answer or press Esc to go back.";
        refresh();
        return;
      }

      const customChoice: AnswerChoice = { value: trimmed, label: trimmed, wasCustom: true };
      if (question.multiple) {
        const withoutPreviousCustom = choicesFor(question).filter((choice) => !choice.wasCustom);
        setChoices(question, [...withoutPreviousCustom, customChoice]);
        closeInlineInput();
        return;
      }

      setChoices(question, [customChoice]);
      inputMode = false;
      inputQuestionId = null;
      inputError = undefined;
      answerEditor.setText("");
      syncEditorFocus();
      advanceAfterAnswer();
    }

    answerEditor.onSubmit = (text: string) => saveCustomAnswer(text);

    function toggleOption(question: Question, option: RenderOption, index: number, source: "enter" | "space") {
      if (option.isOther) {
        const custom = customChoiceFor(question);
        if (question.multiple && source === "space" && custom) {
          setChoices(question, choicesFor(question).filter((choice) => !choice.wasCustom));
          refresh();
          return;
        }
        openInlineInput(question);
        return;
      }

      const choice: AnswerChoice = {
        value: option.value,
        label: option.label,
        wasCustom: false,
        index: index + 1,
      };

      if (question.multiple) {
        const current = choicesFor(question);
        const exists = current.some((existing) => !existing.wasCustom && existing.index === choice.index);
        setChoices(
          question,
          exists
            ? current.filter((existing) => existing.wasCustom || existing.index !== choice.index)
            : [...current, choice],
        );
        refresh();
        return;
      }

      setChoices(question, [choice]);
      advanceAfterAnswer();
    }

    function chooseOption(index: number, source: "enter" | "space" = "enter") {
      const question = currentQuestion();
      const options = currentOptions();
      const option = options[index];
      if (!question || !option) return;
      optionIndex = index;
      toggleOption(question, option, index, source);
    }

    function handleInput(data: string) {
      if (inputMode) {
        if (matchesKey(data, Key.escape)) {
          closeInlineInput();
          return;
        }
        answerEditor.handleInput(data);
        inputError = undefined;
        if (inputMode) refresh();
        return;
      }

      if (showTabs && (matchesKey(data, Key.tab) || matchesKey(data, Key.right))) {
        setTab(currentTab + 1);
        return;
      }
      if (showTabs && (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left))) {
        setTab(currentTab - 1);
        return;
      }

      if (showTabs && currentTab === submitTab) {
        if (matchesKey(data, Key.enter) && allAnswered()) submit(false);
        if (matchesKey(data, Key.escape)) submit(true);
        return;
      }

      const options = currentOptions();
      if (matchesKey(data, Key.up)) {
        optionIndex = Math.max(0, optionIndex - 1);
        refresh();
        return;
      }
      if (matchesKey(data, Key.down)) {
        optionIndex = Math.min(options.length - 1, optionIndex + 1);
        refresh();
        return;
      }
      if (/^[1-9]$/.test(data)) {
        const index = Number(data) - 1;
        if (index >= 0 && index < options.length) chooseOption(index);
        return;
      }
      if (matchesKey(data, Key.space) || data === " ") {
        const question = currentQuestion();
        if (question?.multiple) chooseOption(optionIndex, "space");
        return;
      }
      if (matchesKey(data, Key.enter)) {
        chooseOption(optionIndex);
        return;
      }
      if (matchesKey(data, Key.escape)) {
        submit(true);
      }
    }

    function render(width: number): string[] {
      if (cachedLines) return cachedLines;

      const lineWidth = Math.max(1, width);
      const lines: string[] = [];
      const question = currentQuestion();
      const options = currentOptions();
      const add = (line: string) => lines.push(truncateToWidth(line, lineWidth));
      const addWrapped = (line: string) => {
        for (const wrappedLine of wrapTextWithAnsi(line, lineWidth)) add(wrappedLine);
      };
      const addWrappedIndented = (indent: string, text: string) => {
        const indentWidth = visibleWidth(indent);
        const contentWidth = Math.max(1, lineWidth - indentWidth);
        const continuationIndent = " ".repeat(indentWidth);
        const wrappedLines = wrapTextWithAnsi(text, contentWidth);
        if (wrappedLines.length === 0) {
          add(indent);
          return;
        }
        for (let index = 0; index < wrappedLines.length; index++) {
          add(`${index === 0 ? indent : continuationIndent}${wrappedLines[index]}`);
        }
      };

      add(theme.fg("accent", "─".repeat(lineWidth)));

      if (showTabs) {
        const tabs: string[] = ["← "];
        for (let i = 0; i < questions.length; i++) {
          const tabQuestion = questions[i];
          const answered = answers.has(tabQuestion.id);
          const active = i === currentTab;
          const box = answered ? "■" : "□";
          const text = ` ${box} ${tabQuestion.label} `;
          const styled = active
            ? theme.bg("selectedBg", theme.fg("text", text))
            : theme.fg(answered ? "success" : "text", text);
          tabs.push(styled);
        }

        const canSubmit = allAnswered();
        const submitText = " ✓ Submit ";
        const submitStyled = currentTab === submitTab
          ? theme.bg("selectedBg", theme.fg("text", submitText))
          : theme.fg(canSubmit ? "success" : "dim", submitText);
        tabs.push(`${submitStyled}→`);
        add(` ${tabs.join(" ")}`);
        lines.push("");
      }

      function renderOptions() {
        if (!question) return;
        for (let i = 0; i < options.length; i++) {
          const option = options[i];
          const selectedCursor = i === optionIndex;
          const selectedValue = option.isOther ? customChoiceFor(question) !== undefined : hasOptionChoice(question, i);
          const prefix = selectedCursor ? theme.fg("accent", "› ") : "  ";
          const label = option.isOther && inputMode && inputQuestionId === question.id ? `${option.label} ✎` : option.label;

          if (question.multiple) {
            const box = selectedValue ? theme.fg("success", "■ ") : theme.fg("muted", "□ ");
            const color = selectedCursor ? "accent" : selectedValue ? "success" : "text";
            addWrappedIndented(`${prefix}${box}${theme.fg(color, `${i + 1}. `)}`, theme.fg(color, label));
          } else {
            const color = selectedCursor ? "accent" : selectedValue ? "success" : "text";
            const marker = selectedValue ? theme.fg("success", "✓ ") : "";
            addWrappedIndented(`${prefix}${theme.fg(color, `${i + 1}. `)}${marker}`, theme.fg(color, label));
          }

          if (option.description) addWrappedIndented("     ", theme.fg("muted", option.description));

          if (option.isOther) {
            const custom = customChoiceFor(question);
            if (custom && !(inputMode && inputQuestionId === question.id)) {
              addWrappedIndented("     ", `${theme.fg("success", "✓ ")}${theme.fg("text", custom.label)}`);
              if (question.multiple) addWrappedIndented("     ", theme.fg("dim", "Space on this row clears it; Enter edits it"));
            }
            if (inputMode && inputQuestionId === question.id) {
              syncEditorFocus();
              add(theme.fg("muted", " Your answer:"));
              const inlineInput = makeInlineInput(answerEditor);
              for (const line of renderInlineInput(inlineInput, getInlineInputWidth(lineWidth))) {
                add(` ${line}`);
              }
              if (inputError) addWrappedIndented("     ", theme.fg("warning", inputError));
            }
          }
        }
      }

      if (showTabs && currentTab === submitTab) {
        add(theme.fg("accent", theme.bold("Ready to submit")));
        lines.push("");
        for (const formQuestion of questions) {
          const answer = answers.get(formQuestion.id);
          if (!answer) {
            add(`${theme.fg("muted", `${formQuestion.label}: `)}${theme.fg("dim", "not answered")}`);
            continue;
          }
          const prefix = answer.multiple ? "selected: " : answer.choices[0]?.wasCustom ? "wrote: " : "selected: ";
          const value = answer.multiple ? answer.choices.map(formatChoice).join("; ") : answer.choices[0]?.label ?? answer.label;
          addWrapped(`${theme.fg("muted", `${formQuestion.label}: `)}${theme.fg("text", prefix + value)}`);
        }
        lines.push("");
        if (allAnswered()) add(theme.fg("success", "Press Enter to submit"));
        else {
          const missing = questions.filter((q) => !answers.has(q.id)).map((q) => q.label).join(", ");
          add(theme.fg("warning", `Unanswered: ${missing}`));
        }
      } else if (question) {
        addWrapped(theme.fg("accent", theme.bold(question.prompt)));
        lines.push("");
        renderOptions();
      }

      lines.push("");
      if (!inputMode) {
        let help = question?.multiple
          ? "Space/Enter to toggle · Tab/Arrow keys to navigate · Esc to cancel"
          : showTabs
            ? "Enter to select · Tab/Arrow keys to navigate · Esc to cancel"
            : "Enter to select · ↑↓ to navigate · Esc to cancel";
        if (showTabs && currentTab === submitTab) help = "Enter to submit · Tab/Arrow keys to navigate · Esc to cancel";
        add(theme.fg("dim", help));
      } else {
        add(theme.fg("dim", "Enter to submit • Shift/Ctrl/Alt+Enter for newline • Esc to go back"));
      }
      add(theme.fg("accent", "─".repeat(lineWidth)));

      cachedLines = lines;
      return lines;
    }

    return {
      get focused() {
        return focused;
      },
      set focused(value: boolean) {
        focused = value;
        syncEditorFocus();
        refresh();
      },
      render,
      invalidate: () => {
        cachedLines = undefined;
      },
      handleInput,
    };
  });
}
function errorResult(message: string, questions: Question[] = []): AgentToolResult<AskUserQuestionDetails> {
	return {
		content: [{ type: "text", text: message }],
		details: { questions, answers: [], cancelled: true },
	};
}

export default function askUserQuestionExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "askUserQuestion",
		label: "Ask User Question",
		description:
			"Ask the user one or more structured questions in an interactive form with tabs, selectable options, optional descriptions, optional multiple-select questions, and a multiline free-text 'Type something' editor. Use when you need clarification or user preferences before proceeding.",
		promptSnippet: "Ask the user structured clarification questions with selectable options, multiple-select questions, and multiline free-text answers.",
		promptGuidelines: [
			"Use askUserQuestion when user intent, requirements, or preferences are ambiguous and a short structured choice would help.",
			"When using askUserQuestion, include concise option labels and helpful descriptions so the user can answer quickly.",
			"Set askUserQuestion question.multiple=true when the user may choose more than one option.",
			"Use multiline free-text answers when the user needs to provide longer input.",
		],
		parameters: AskUserQuestionSchema,
		executionMode: "sequential",
		renderShell: "self",

		async execute(_toolCallId, params: AskUserQuestionParams, _signal, _onUpdate, ctx) {
			const questions = normalizeQuestions(params.questions ?? []);

			if (!ctx.hasUI) {
				return errorResult("Error: askUserQuestion requires interactive mode; UI is not available.", questions);
			}
			if (questions.length === 0) {
				return errorResult("Error: No questions were provided.", questions);
			}
			if (questions.some((question) => makeOptions(question).length === 0)) {
				return errorResult("Error: Each question needs at least one option or allowOther=true.", questions);
			}

			const result = await showAskUserQuestionForm(ctx, questions);
			if (result.cancelled) {
				return {
					content: [{ type: "text", text: "User cancelled the question form." }],
					details: result,
				};
			}

			return {
				content: [{ type: "text", text: formatAnswerLines(result).join("\n") }],
				details: result,
			};
		},

		renderCall(args, theme, context) {
			const renderContext = context as unknown as RenderContext;
			const questions = normalizeQuestions((args.questions as RawQuestion[] | undefined) ?? []);
			const labels = questions.map((question) => question.label).join(", ");
			const summary = labels ? truncateToWidth(labels, 48) : `${questions.length} question${questions.length === 1 ? "" : "s"}`;
			return textComponent(renderContext, callHeader(theme, renderContext, "AskUserQuestion", summary));
		},

		renderResult(result, _options, theme, context) {
			const renderContext = context as unknown as RenderContext;
			const details = result.details as AskUserQuestionDetails | undefined;
			if (!details) {
				const first = result.content[0];
				return textComponent(renderContext, first?.type === "text" ? (first.text ?? "") : "");
			}
			if (details.cancelled) return textComponent(renderContext, treeLines(theme, "Cancelled", [], { warning: true }));

			const lines = details.answers.map((answer) => {
				const question = details.questions.find((q) => q.id === answer.id);
				const label = question?.label ?? answer.id;
				const display = answer.multiple ? answer.choices.map(formatChoice).join("; ") : formatChoice(answer.choices[0]);
				return `${theme.fg("accent", label)}: ${theme.fg("text", display)}`;
			});
			return textComponent(renderContext, treeLines(theme, `Answered ${details.answers.length} question${details.answers.length === 1 ? "" : "s"}`, lines));
		},
	});
}

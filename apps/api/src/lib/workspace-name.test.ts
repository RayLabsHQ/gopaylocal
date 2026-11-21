import { describe, it, expect } from "vitest";
import {
  checkWorkspaceName,
  workspaceNameForEmail,
  WORKSPACE_NAME_LINK_ERROR,
  WORKSPACE_NAME_MAX,
} from "./workspace-name";

describe("checkWorkspaceName", () => {
  it.each([
    ["Acme", "Acme"],
    ["  Acme   Labs  ", "Acme Labs"],
    ["Acme Labs", "Acme Labs"], // no-break space is a space
    ["Müller & Söhne GmbH", "Müller & Söhne GmbH"],
    ["O'Brien's Courses (EU)", "O'Brien's Courses (EU)"],
    ["Acme Inc.", "Acme Inc."],
    ["Web 2.0 Labs", "Web 2.0 Labs"],
    ["A+ Tutors!", "A+ Tutors!"],
    ["dev_tools-co", "dev_tools-co"],
    ["Café", "Café"], // NFC
    ["Go", "Go"],
    // Dots inside a name: brand names with a domain in them.
    ["Cal.com", "Cal.com"],
    ["acme.com", "acme.com"],
    ["J.P. Morgan Courses", "J.P. Morgan Courses"],
    // Names written only in a non-Latin script.
    ["株式会社テスト", "株式会社テスト"],
    ["（株）テスト", "（株）テスト"],
    ["ジョンソン・エンド・ジョンソン", "ジョンソン・エンド・ジョンソン"],
    ["测试公司", "测试公司"],
    ["회사 테스트", "회사 테스트"],
    ["Компания Тест", "Компания Тест"],
    ["Ελληνική Εταιρεία", "Ελληνική Εταιρεία"],
    ["شركة الاختبار", "شركة الاختبار"],
    ["חברת בדיקה בע״מ", "חברת בדיקה בע״מ"],
    ["परीक्षण कंपनी", "परीक्षण कंपनी"], // Devanagari vowel signs and virama are combining marks
    ["บริษัท ทดสอบ", "บริษัท ทดสอบ"],
    ["Café · Bar", "Café · Bar"],
  ])("accepts %j as %j", (input, name) => {
    expect(checkWorkspaceName(input)).toEqual({ ok: true, name });
  });

  it("accepts exactly the maximum length, counting characters not bytes", () => {
    expect(checkWorkspaceName("é".repeat(WORKSPACE_NAME_MAX)).ok).toBe(true);
    expect(checkWorkspaceName("é".repeat(WORKSPACE_NAME_MAX + 1)).ok).toBe(false);
  });

  it.each([
    ["www", "www.acme"],
    ["www in a sentence", "Visit www.acme now"],
    ["upper-case www", "WWW.ACME.COM"],
    ["a scheme", "https://acme"],
    ["a scheme without slashes", "mailto:x"],
    ["a javascript scheme", "javascript:alert(1)"],
    ["a host and port", "localhost:8080"],
    ["a path", "acme.com/login"],
    ["a slash", "Acme/Labs"],
    ["a backslash", "Acme\\Labs"],
    ["an email", "a@b"],
  ])("refuses %s as a link", (_label, input) => {
    expect(checkWorkspaceName(input)).toEqual({ ok: false, error: WORKSPACE_NAME_LINK_ERROR });
  });

  it.each([
    ["empty", ""],
    ["spaces only", "   "],
    ["one character", "A"],
    ["punctuation only", "&&"],
    ["markup", "<b>Acme</b>"],
    ["quotes", 'Acme "Labs"'],
    ["a colon", "Acme: Labs"],
    ["an ideographic full stop (read as a dot in domains)", "example。com"],
    ["a full-width full stop", "example．com"],
    ["a newline", "Acme\nLabs"],
    ["a tab", "Acme\tLabs"],
    ["a NUL", "Acme\u0000"],
    ["a zero-width space", "Ac​me"],
    ["a right-to-left override", "Acme‮gnp.exe"],
    ["a line separator", "Acme Labs"],
    ["an emoji", "Acme 🚀"],
    ["not a string", 42],
    ["null", null],
  ])("refuses %s", (_label, input) => {
    const result = checkWorkspaceName(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.length).toBeGreaterThan(0);
  });
});

describe("workspaceNameForEmail", () => {
  it.each([
    ["Acme Labs", "Acme Labs"],
    ["  Acme   Labs ", "Acme Labs"],
    ["Acme Inc.", "Acme Inc."],
    ["Web 2.0 Labs", "Web 2.0 Labs"],
    ["J.P. Morgan Courses", "J.P. Morgan Courses"],
    ["株式会社テスト", "株式会社テスト"],
  ])("prints %j as %j", (stored, printed) => {
    expect(workspaceNameForEmail(stored)).toBe(printed);
  });

  it.each([
    ["a brand name with a domain (mail clients link it)", "Cal.com"],
    ["a domain in a sentence", "Pay at evil.example now"],
    ["an internationalised domain", "пример.рф"],
    ["a stored name that breaks the rule", "https://evil.example"],
    ["a stored name with a bidi override", "Acme‮gnp.exe"],
    ["no name", undefined],
  ])("never prints %s", (_label, stored) => {
    expect(workspaceNameForEmail(stored)).toBeNull();
  });
});

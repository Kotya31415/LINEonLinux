#!/usr/bin/env python3
"""Dependency-free preview of the Linux chat UI architecture.
Run: python3 demo.py
The production target is the GTK4 Rust frontend in src/main.rs.
"""
import tkinter as tk
from tkinter import ttk

CHATS = [
    ("Alice", "明日の予定どうする？", 2),
    ("開発メモ", "prototype を push しました", 0),
    ("Bob", "画像を送信しました", 0),
]
MESSAGES = [
    ("Alice", "こんにちは！", False),
    ("自分", "こんにちは。Linux版クライアントを試しています。", True),
    ("Alice", "明日の予定どうする？", False),
]

class Demo(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("LINE Native Linux Prototype")
        self.geometry("1050x700")
        self.minsize(850, 540)
        self.configure(padx=8, pady=8)
        self._build()

    def _build(self):
        main = ttk.Panedwindow(self, orient=tk.HORIZONTAL)
        main.pack(fill=tk.BOTH, expand=True)
        left = ttk.Frame(main, padding=8)
        right = ttk.Frame(main, padding=8)
        main.add(left, weight=1)
        main.add(right, weight=3)
        self.search = ttk.Entry(left)
        self.search.insert(0, "検索")
        self.search.pack(fill=tk.X, pady=(0, 8))
        self.chats = tk.Listbox(left, borderwidth=0, highlightthickness=0)
        self.chats.pack(fill=tk.BOTH, expand=True)
        for name, preview, unread in CHATS:
            suffix = f"  [{unread}]" if unread else ""
            self.chats.insert(tk.END, f"{name}  {preview}{suffix}")
        self.chats.selection_set(0)
        self.title_label = ttk.Label(right, text="Alice", font=("TkDefaultFont", 15, "bold"))
        self.title_label.pack(anchor="w", pady=(0, 8))
        self.messages = tk.Text(right, state="disabled", wrap="word", borderwidth=0)
        self.messages.pack(fill=tk.BOTH, expand=True)
        self.composer = ttk.Frame(right)
        self.composer.pack(fill=tk.X, pady=(8, 0))
        self.input = tk.Text(self.composer, height=4, wrap="word")
        self.input.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        ttk.Button(self.composer, text="送信", command=self.send).pack(side=tk.LEFT, padx=(8, 0))
        self.render_messages()
        self.chats.bind("<<ListboxSelect>>", self.change_chat)

    def render_messages(self):
        self.messages.configure(state="normal")
        self.messages.delete("1.0", tk.END)
        for sender, text, outgoing in MESSAGES:
            self.messages.insert(tk.END, f"{sender}\n{text}\n\n", "out" if outgoing else "in")
        self.messages.tag_configure("out", justify="right", lmargin1=180)
        self.messages.tag_configure("in", justify="left", rmargin=180)
        self.messages.configure(state="disabled")

    def change_chat(self, _event):
        idx = self.chats.curselection()[0]
        self.title_label.configure(text=CHATS[idx][0])

    def send(self):
        text = self.input.get("1.0", tk.END).strip()
        if not text:
            return
        MESSAGES.append(("自分", text, True))
        self.input.delete("1.0", tk.END)
        self.render_messages()

if __name__ == "__main__":
    Demo().mainloop()

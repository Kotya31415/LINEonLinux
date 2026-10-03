use gtk4 as gtk;
use gtk::prelude::*;
use gtk::{Application, ApplicationWindow, Box, Button, Entry, Label, ListBox, ListBoxRow, Orientation, Paned, ScrolledWindow, TextView};
use serde::{Deserialize, Serialize};
use std::cell::RefCell;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{ChildStdin, Command, Stdio};
use std::rc::Rc;
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};
use std::thread;

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Chat {
    id: String,
    name: String,
    preview: String,
    unread: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Message {
    id: String,
    chat_id: String,
    sender: String,
    text: String,
    outgoing: bool,
}

#[derive(Clone, Default)]
struct State {
    chats: Vec<Chat>,
    messages: HashMap<String, Vec<Message>>,
    selected_chat: Option<String>,
}


struct Bridge {
    stdin: Arc<Mutex<ChildStdin>>,
    rx: Receiver<serde_json::Value>,
}

impl Bridge {
    fn spawn() -> Result<Self, String> {
        let mut child = Command::new("node")
            .arg("bridge/linejs_bridge.mjs")
            .current_dir(env!("CARGO_MANIFEST_DIR"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| format!("failed to start node bridge: {e}"))?;

        let stdin = child.stdin.take().ok_or("bridge stdin unavailable")?;
        let stdout = child.stdout.take().ok_or("bridge stdout unavailable")?;
        let (tx, rx) = mpsc::channel();

        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().flatten() {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) {
                    let _ = tx.send(value);
                }
            }
        });

        Ok(Self { stdin: Arc::new(Mutex::new(stdin)), rx })
    }

    fn request(&self, value: serde_json::Value) -> Result<(), String> {
        let mut stdin = self.stdin.lock().map_err(|_| "bridge stdin lock poisoned".to_string())?;
        writeln!(stdin, "{}", value).map_err(|e| format!("bridge write failed: {e}"))?;
        stdin.flush().map_err(|e| format!("bridge flush failed: {e}"))
    }
}

fn open_qr_window(parent: &ApplicationWindow, url: &str) {
    let qr_path = std::env::temp_dir().join("line-native-linux-qr.png");
    let generated = Command::new("qrencode")
        .args(["-o", qr_path.to_string_lossy().as_ref(), url])
        .status()
        .map(|s| s.success())
        .unwrap_or(false);

    let dialog = gtk::Window::builder()
        .transient_for(parent)
        .modal(true)
        .title("LINE QR Login")
        .default_width(440)
        .default_height(560)
        .build();
    let box_ = Box::new(Orientation::Vertical, 12);
    box_.set_margin_top(18);
    box_.set_margin_bottom(18);
    box_.set_margin_start(18);
    box_.set_margin_end(18);

    if generated {
        let picture = gtk::Picture::for_filename(qr_path);
        picture.set_can_shrink(true);
        picture.set_vexpand(true);
        box_.append(&picture);
    }

    let label = Label::new(Some("LINEアプリでこのQRを読み取ってログインしてください。\n\nURLはローカルの画面だけに表示しています。"));
    label.set_wrap(true);
    box_.append(&label);
    if !generated {
        let url_label = Label::new(Some(url));
        url_label.set_selectable(true);
        url_label.set_wrap(true);
        box_.append(&url_label);
        let hint = Label::new(Some("qrencode をインストールすると、このダイアログでQRを表示できます。"));
        hint.set_wrap(true);
        hint.add_css_class("muted");
        box_.append(&hint);
    }
    let close = Button::with_label("閉じる");
    let dialog_clone = dialog.clone();
    close.connect_clicked(move |_| dialog_clone.close());
    box_.append(&close);
    dialog.set_child(Some(&box_));
    dialog.present();
}

fn seed_state() -> State {
    let chats = vec![
        Chat { id: "u-alice".into(), name: "Alice".into(), preview: "明日の予定どうする？".into(), unread: 2 },
        Chat { id: "c-dev".into(), name: "開発メモ".into(), preview: "prototype を push しました".into(), unread: 0 },
        Chat { id: "u-bob".into(), name: "Bob".into(), preview: "画像を送信しました".into(), unread: 0 },
    ];
    let messages = HashMap::from([
        ("u-alice".into(), vec![
            Message { id: "1".into(), chat_id: "u-alice".into(), sender: "Alice".into(), text: "こんにちは！".into(), outgoing: false },
            Message { id: "2".into(), chat_id: "u-alice".into(), sender: "自分".into(), text: "こんにちは。Linux版クライアントを試しています。".into(), outgoing: true },
            Message { id: "3".into(), chat_id: "u-alice".into(), sender: "Alice".into(), text: "明日の予定どうする？".into(), outgoing: false },
        ]),
        ("c-dev".into(), vec![
            Message { id: "4".into(), chat_id: "c-dev".into(), sender: "Kai".into(), text: "Rust + GTK4 のUIを試しています。".into(), outgoing: false },
            Message { id: "5".into(), chat_id: "c-dev".into(), sender: "自分".into(), text: "prototype を push しました。".into(), outgoing: true },
        ]),
        ("u-bob".into(), vec![
            Message { id: "6".into(), chat_id: "u-bob".into(), sender: "Bob".into(), text: "画像を送信しました".into(), outgoing: false },
        ]),
    ]);
    State { chats, messages, selected_chat: Some("u-alice".into()) }
}

fn apply_css() {
    let provider = gtk::CssProvider::new();
    provider.load_from_data(r#"
        .sidebar { background: @window_bg_color; }
        .chat-row { padding: 9px 10px; }
        .chat-title { font-weight: 600; }
        .chat-preview { opacity: 0.72; font-size: 0.9em; }
        .message { padding: 7px 11px; border-radius: 14px; }
        .incoming { background: alpha(@theme_fg_color, 0.08); }
        .outgoing { background: alpha(@theme_accent_color, 0.18); }
        .muted { opacity: 0.6; }
    "#);
    if let Some(display) = gtk::gdk::Display::default() {
        gtk::style_context_add_provider_for_display(&display, &provider, gtk::STYLE_PROVIDER_PRIORITY_APPLICATION);
    }
}

fn clear_container(container: &ListBox) {
    while let Some(child) = container.first_child() {
        container.remove(&child);
    }
}

fn render_messages(state: &State, chat_id: &str, message_list: &ListBox, title: &Label) {
    clear_container(message_list);
    if let Some(chat) = state.chats.iter().find(|c| c.id == chat_id) {
        title.set_text(&chat.name);
    }
    for msg in state.messages.get(chat_id).cloned().unwrap_or_default() {
        let row = ListBoxRow::new();
        row.add_css_class("message");
        row.add_css_class(if msg.outgoing { "outgoing" } else { "incoming" });
        let box_ = Box::new(Orientation::Vertical, 2);
        let author = Label::new(Some(&msg.sender));
        author.set_xalign(if msg.outgoing { 1.0 } else { 0.0 });
        author.add_css_class("muted");
        let body = Label::new(Some(&msg.text));
        body.set_wrap(true);
        body.set_xalign(if msg.outgoing { 1.0 } else { 0.0 });
        body.set_selectable(true);
        box_.append(&author);
        box_.append(&body);
        row.set_child(Some(&box_));
        message_list.append(&row);
    }
}

fn rebuild_chat_list(state: &State, chat_list: &ListBox, filter: &str, selected: &str, on_select: Rc<dyn Fn(String)>) {
    clear_container(chat_list);
    let query = filter.trim().to_lowercase();
    for chat in state.chats.iter() {
        if !query.is_empty() && !chat.name.to_lowercase().contains(&query) && !chat.preview.to_lowercase().contains(&query) {
            continue;
        }
        let row = ListBoxRow::new();
        row.set_activatable(true);
        row.add_css_class("chat-row");
        let outer = Box::new(Orientation::Vertical, 2);
        let header = Box::new(Orientation::Horizontal, 6);
        let title = Label::new(Some(&chat.name));
        title.set_xalign(0.0);
        title.add_css_class("chat-title");
        let spacer = Box::new(Orientation::Horizontal, 0);
        spacer.set_hexpand(true);
        header.append(&title);
        header.append(&spacer);
        if chat.unread > 0 {
            let unread = Label::new(Some(&chat.unread.to_string()));
            unread.add_css_class("muted");
            header.append(&unread);
        }
        let preview = Label::new(Some(&chat.preview));
        preview.set_xalign(0.0);
        preview.set_ellipsize(gtk::pango::EllipsizeMode::End);
        preview.add_css_class("chat-preview");
        outer.append(&header);
        outer.append(&preview);
        row.set_child(Some(&outer));
        let id = chat.id.clone();
        let cb = on_select.clone();
        row.connect_activate(move |_| cb(id.clone()));
        if chat.id == selected { chat_list.select_row(Some(&row)); }
        chat_list.append(&row);
    }
}

fn main() {
    let app = Application::builder().application_id("dev.example.LineNativeLinux").build();
    app.connect_activate(|app| {
        apply_css();
        let state = Rc::new(RefCell::new(seed_state()));

        let window = ApplicationWindow::builder()
            .application(app)
            .title("LINE Native Linux Prototype")
            .default_width(1120)
            .default_height(760)
            .build();

        let root = Paned::new(Orientation::Horizontal);
        root.set_wide_handle(true);
        window.set_child(Some(&root));

        // Sidebar
        let sidebar = Box::new(Orientation::Vertical, 8);
        sidebar.add_css_class("sidebar");
        sidebar.set_margin_top(10);
        sidebar.set_margin_bottom(10);
        sidebar.set_margin_start(10);
        sidebar.set_margin_end(10);
        sidebar.set_size_request(310, -1);

        let search = Entry::builder().placeholder_text("検索").build();
        sidebar.append(&search);
        let chat_scroll = ScrolledWindow::builder().hexpand(true).vexpand(true).build();
        let chat_list = ListBox::new();
        chat_list.set_selection_mode(gtk::SelectionMode::Single);
        chat_scroll.set_child(Some(&chat_list));
        sidebar.append(&chat_scroll);
        root.set_start_child(Some(&sidebar));

        // Main area
        let main = Box::new(Orientation::Vertical, 0);
        let topbar = Box::new(Orientation::Horizontal, 10);
        topbar.set_margin_top(10);
        topbar.set_margin_bottom(10);
        topbar.set_margin_start(14);
        topbar.set_margin_end(14);
        let title = Label::new(Some(""));
        title.set_xalign(0.0);
        title.add_css_class("chat-title");
        topbar.append(&title);
        let top_spacer = Box::new(Orientation::Horizontal, 0);
        top_spacer.set_hexpand(true);
        topbar.append(&top_spacer);
        let status = Label::new(Some("Offline prototype"));
        status.add_css_class("muted");
        topbar.append(&status);
        let connect = Button::with_label("LINE接続");
        topbar.append(&connect);
        main.append(&topbar);

        let bridge_slot: Rc<RefCell<Option<Bridge>>> = Rc::new(RefCell::new(None));
        let bridge_for_connect = bridge_slot.clone();
        let window_for_connect = window.clone();
        let status_for_connect = status.clone();
        connect.connect_clicked(move |_| {
            if bridge_for_connect.borrow().is_some() {
                status_for_connect.set_text("LINE bridge running");
                return;
            }
            match Bridge::spawn() {
                Ok(bridge) => {
                    if let Err(e) = bridge.request(serde_json::json!({"method":"login_qr"})) {
                        status_for_connect.set_text(&e);
                    } else {
                        *bridge_for_connect.borrow_mut() = Some(bridge);
                        status_for_connect.set_text("QR login started");
                    }
                }
                Err(e) => status_for_connect.set_text(&e),
            }
            let _ = &window_for_connect;
        });

        let message_scroll = ScrolledWindow::builder().hexpand(true).vexpand(true).build();
        let message_list = ListBox::new();
        message_list.set_selection_mode(gtk::SelectionMode::None);
        message_scroll.set_child(Some(&message_list));
        main.append(&message_scroll);

        let composer = Box::new(Orientation::Horizontal, 8);
        composer.set_margin_top(10);
        composer.set_margin_bottom(12);
        composer.set_margin_start(12);
        composer.set_margin_end(12);
        let input = TextView::builder().wrap_mode(gtk::WrapMode::WordChar).vexpand(false).hexpand(true).build();
        input.set_size_request(-1, 70);
        composer.append(&input);
        let send = Button::with_label("送信");
        composer.append(&send);
        main.append(&composer);
        root.set_end_child(Some(&main));

        // Selection callback updates the main pane.
        let select_chat2: Rc<dyn Fn(String)> = Rc::new({
            let state = state.clone();
            let message_list = message_list.clone();
            let title = title.clone();
            move |id| {
                state.borrow_mut().selected_chat = Some(id.clone());
                render_messages(&state.borrow(), &id, &message_list, &title);
            }
        });
        let selected = state.borrow().selected_chat.clone().unwrap_or_default();
        rebuild_chat_list(&state.borrow(), &chat_list, "", &selected, select_chat2.clone());
        render_messages(&state.borrow(), &selected, &message_list, &title);

        // Search re-renders the sidebar.
        let chat_list_for_search = chat_list.clone();
        let state_for_search = state.clone();
        let select_for_search = select_chat2.clone();
        search.connect_changed(move |entry| {
            let selected = state_for_search.borrow().selected_chat.clone().unwrap_or_default();
            rebuild_chat_list(&state_for_search.borrow(), &chat_list_for_search, entry.text().as_str(), &selected, select_for_search.clone());
        });

        // Offline send path; this is the seam where the linejs RPC call will be inserted.
        let state_for_send = state.clone();
        let input_for_send = input.clone();
        let message_list_for_send = message_list.clone();
        let title_for_send = title.clone();
        send.connect_clicked(move |_| {
            let Some(chat_id) = state_for_send.borrow().selected_chat.clone() else { return; };
            let buffer = input_for_send.buffer();
            let text = buffer.text(&buffer.start_iter(), &buffer.end_iter(), true).to_string();
            if text.trim().is_empty() { return; }
            let message = Message {
                id: format!("local-{}", state_for_send.borrow().messages.values().map(Vec::len).sum::<usize>() + 1),
                chat_id: chat_id.clone(),
                sender: "自分".into(),
                text: text.trim_end().into(),
                outgoing: true,
            };
            state_for_send.borrow_mut().messages.entry(chat_id.clone()).or_default().push(message);
            if let Some(chat) = state_for_send.borrow_mut().chats.iter_mut().find(|c| c.id == chat_id) {
                chat.preview = text.trim_end().into();
            }
            buffer.set_text("");
            render_messages(&state_for_send.borrow(), &chat_id, &message_list_for_send, &title_for_send);
        });

        // Poll sidecar events without blocking the GTK main loop.
        let bridge_for_poll = bridge_slot.clone();
        let window_for_poll = window.clone();
        let status_for_poll = status.clone();
        gtk::glib::timeout_add_local(std::time::Duration::from_millis(100), move || {
            let mut remove_bridge = false;
            if let Some(bridge) = bridge_for_poll.borrow().as_ref() {
                while let Ok(event) = bridge.rx.try_recv() {
                    match event.get("type").and_then(|v| v.as_str()) {
                        Some("qr") => {
                            if let Some(url) = event.get("url").and_then(|v| v.as_str()) {
                                open_qr_window(&window_for_poll, url);
                            }
                        }
                        Some("pin") => {
                            if let Some(pin) = event.get("pin").and_then(|v| v.as_str()) {
                                status_for_poll.set_text(&format!("LINE PIN: {pin}"));
                            }
                        }
                        Some("ready") => status_for_poll.set_text("LINE接続済み"),
                        Some("error") => {
                            let msg = event.get("message").and_then(|v| v.as_str()).unwrap_or("LINE bridge error");
                            status_for_poll.set_text(msg);
                        }
                        _ => {}
                    }
                }
            }
            if remove_bridge {
                bridge_for_poll.borrow_mut().take();
            }
            gtk::glib::ControlFlow::Continue
        });

        window.present();
    });
    app.run();
}

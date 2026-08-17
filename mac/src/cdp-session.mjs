export class CdpSession {
  #nextId = 1;
  #pending = new Map();
  #closed = false;

  constructor(socket, { onEvent = () => {}, onClose = () => {} } = {}) {
    this.socket = socket;
    this.onEvent = onEvent;
    this.onClose = onClose;
    if (socket.addEventListener) {
      socket.addEventListener("message", (event) => this.#receive(event.data));
      socket.addEventListener("close", () => this.#terminate("CDP 会话已关闭"));
      socket.addEventListener("error", () => this.#terminate("CDP 连接发生错误"));
    } else if (socket.on) {
      socket.on("message", (data) => this.#receive(data));
      socket.on("close", () => this.#terminate("CDP 会话已关闭"));
      socket.on("error", () => this.#terminate("CDP 连接发生错误"));
    }
  }

  send(method, params = {}) {
    if (this.#closed) {
      return Promise.reject(new Error("CDP 会话已关闭"));
    }

    const id = this.#nextId++;
    const promise = new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    try {
      this.socket.send(JSON.stringify({ id, method, params }));
    } catch (error) {
      this.#pending.delete(id);
      return Promise.reject(error);
    }
    return promise;
  }

  close() {
    this.#terminate("CDP 会话已关闭");
    this.socket.close?.();
  }

  #receive(data) {
    let message;
    try {
      message = JSON.parse(String(data));
    } catch {
      return;
    }

    if (!message || typeof message !== "object") return;
    if (typeof message.id === "number") {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message || "CDP 请求失败"));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (typeof message.method === "string") {
      this.#notify(this.onEvent, message.method, message.params);
    }
  }

  #terminate(message) {
    if (this.#closed) return;
    this.#closed = true;
    for (const { reject } of this.#pending.values()) {
      reject(new Error(message));
    }
    this.#pending.clear();
    this.#notify(this.onClose);
  }

  #notify(callback, ...args) {
    try {
      Promise.resolve(callback(...args)).catch(() => {});
    } catch {
      // 用户回调不应破坏 CDP 事件循环。
    }
  }
}

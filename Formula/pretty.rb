class Pretty < Formula
  desc "Local web UI and CLI for long-lived Claude, Codex, and terminal sessions"
  homepage "https://github.com/uzihaq/pretty-PTY"
  version "0.1.0" # TODO_RELEASE_VERSION: replace before publishing.
  license "MIT"

  on_macos do
    depends_on arch: :arm64
    on_arm do
      # TODO_RELEASE_URL(darwin_arm64): replace the placeholder version before publishing.
      url "https://github.com/uzihaq/pretty-PTY/releases/download/v0.1.0/pretty-pty_0.1.0_darwin_arm64.tar.gz"
      # TODO_RELEASE_SHA256(darwin_arm64): replace the zero digest before publishing.
      sha256 "0000000000000000000000000000000000000000000000000000000000000000"
    end
  end

  on_linux do
    on_arm do
      # TODO_RELEASE_URL(linux_arm64): replace the placeholder version before publishing.
      url "https://github.com/uzihaq/pretty-PTY/releases/download/v0.1.0/pretty-pty_0.1.0_linux_arm64.tar.gz"
      # TODO_RELEASE_SHA256(linux_arm64): replace the zero digest before publishing.
      sha256 "0000000000000000000000000000000000000000000000000000000000000000"
    end

    on_intel do
      # TODO_RELEASE_URL(linux_amd64): replace the placeholder version before publishing.
      url "https://github.com/uzihaq/pretty-PTY/releases/download/v0.1.0/pretty-pty_0.1.0_linux_amd64.tar.gz"
      # TODO_RELEASE_SHA256(linux_amd64): replace the zero digest before publishing.
      sha256 "0000000000000000000000000000000000000000000000000000000000000000"
    end
  end

  def install
    bin.install "pretty", "prettyd", "runner"
  end

  def caveats
    <<~EOS
      On macOS, register and start the per-user daemon with:
        pretty install

      Then open http://localhost:8787. Linux service installation is not yet
      automated; run prettyd under your user supervisor.
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/pretty version")
  end
end

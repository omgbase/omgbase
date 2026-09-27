//! The persistent session behind `omg shell` (`spec/cli` §7): the line
//! [`tokenize`]r, the `@` [`refs`] (parse, rows, coercion) and the
//! [`session`] runtime that executes one line at a time over one open
//! [`super::context::Cli`]. The verb itself (`shell`'s argv, the script
//! runner, the prompted runner and the TTY loop) is `cli::cmd::shell`.

pub mod refs;
pub mod session;
pub mod tokenize;

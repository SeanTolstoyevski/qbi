# Why QBI exists

I'm a visually impaired developer and I use my computer with a screen
reader. Everything at our company runs on Kubernetes and I debug it
constantly.

That combination is painful. The GUI tools either don't work with a screen
reader (Lens is not accessible) or aren't available in every environment
(Rancher is not deployed everywhere). And raw `kubectl`, the one thing that
is always there, is extremely verbose and cumbersome to drive.

At some point I stopped working around it and asked myself: why not write my
own kube inspect / debug tool? I needed it often enough. What I wanted was a
lightweight UI: small, fast and structured in a way a screen reader can
actually navigate: real lists, real headings, no mouse-only interactions.

The first version was a read-only inspector, built for myself. It was an
internal project and I didn't plan to open-source it. But the more I used
it, the more write features crept in, because when you're debugging,
sometimes you need to restart a workload, not just look at it. Then it
occurred to me that other people must be hitting the same wall: looking for a
lightweight, accessible Kubernetes tool. So I published it.

If you're a sighted user, a lot of this will read as "a clean, keyboard-first
UI" and that's accurate. The accessibility work is not a feature for a
niche audience; it's what makes the whole tool fast and low-noise. But QBI
exists because its author needed it and I hope it helps someone else in the
same position.

---

Back to the [README](../README.md).

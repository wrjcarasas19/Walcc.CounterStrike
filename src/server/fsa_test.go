package main

import (
	"errors"
	"testing"
)

func TestFixedArrayAddGetRemove(t *testing.T) {
	fa := NewFixedArray[string](4)

	idx, gen, err := fa.Add("a")
	if err != nil {
		t.Fatalf("Add: %v", err)
	}
	if idx != 0 {
		t.Fatalf("first Add index = %d, want 0", idx)
	}
	got, err := fa.Get(idx)
	if err != nil || got != "a" {
		t.Fatalf("Get = %q, %v; want \"a\", nil", got, err)
	}
	if err := fa.Remove(idx, gen); err != nil {
		t.Fatalf("Remove: %v", err)
	}
	if _, err := fa.Get(idx); !errors.Is(err, errNotInUse) {
		t.Fatalf("Get after Remove err = %v, want %v", err, errNotInUse)
	}
	if err := fa.Remove(idx, gen); !errors.Is(err, errNotInUse) {
		t.Fatalf("double Remove err = %v, want %v", err, errNotInUse)
	}
	if _, err := fa.Get(4); !errors.Is(err, errOutOfBounds) {
		t.Fatalf("Get out of bounds err = %v, want %v", err, errOutOfBounds)
	}
}

func TestFixedArrayReuseRejectsStaleOwner(t *testing.T) {
	fa := NewFixedArray[string](1)

	idx, oldGen, err := fa.Add("old")
	if err != nil {
		t.Fatalf("Add: %v", err)
	}
	if err := fa.Remove(idx, oldGen); err != nil {
		t.Fatalf("Remove: %v", err)
	}

	newIdx, newGen, err := fa.Add("new")
	if err != nil {
		t.Fatalf("Add after Remove: %v", err)
	}
	if newIdx != idx {
		t.Fatalf("reused index = %d, want %d", newIdx, idx)
	}
	if newGen == oldGen {
		t.Fatalf("generation not bumped on reuse: %d", newGen)
	}

	if err := fa.Replace(idx, oldGen, "stale"); !errors.Is(err, errStaleGeneration) {
		t.Fatalf("stale Replace err = %v, want %v", err, errStaleGeneration)
	}
	if err := fa.Remove(idx, oldGen); !errors.Is(err, errStaleGeneration) {
		t.Fatalf("stale Remove err = %v, want %v", err, errStaleGeneration)
	}
	if got, err := fa.Get(idx); err != nil || got != "new" {
		t.Fatalf("Get after stale ops = %q, %v; want \"new\", nil", got, err)
	}

	if err := fa.Replace(idx, newGen, "replaced"); err != nil {
		t.Fatalf("Replace: %v", err)
	}
	if got, _ := fa.Get(idx); got != "replaced" {
		t.Fatalf("Get after Replace = %q, want \"replaced\"", got)
	}
	if err := fa.Remove(idx, newGen); err != nil {
		t.Fatalf("Remove by current owner: %v", err)
	}
}

func TestFixedArrayFull(t *testing.T) {
	fa := NewFixedArray[int](2)

	seen := map[byte]bool{}
	for i := 0; i < 2; i++ {
		idx, _, err := fa.Add(i)
		if err != nil {
			t.Fatalf("Add %d: %v", i, err)
		}
		if seen[idx] {
			t.Fatalf("index %d handed out twice", idx)
		}
		seen[idx] = true
	}
	if _, _, err := fa.Add(2); !errors.Is(err, errArrayFull) {
		t.Fatalf("Add to full array err = %v, want %v", err, errArrayFull)
	}
}

func TestFixedArrayItems(t *testing.T) {
	fa := NewFixedArray[string](4)
	if items := fa.Items(); len(items) != 0 {
		t.Fatalf("empty Items = %q", items)
	}
	fa.Add("a")
	idx, gen, _ := fa.Add("b")
	fa.Add("c")
	fa.Remove(idx, gen)
	if items := fa.Items(); len(items) != 2 || items[0] != "a" || items[1] != "c" {
		t.Fatalf("Items = %q, want [a c]", items)
	}
}

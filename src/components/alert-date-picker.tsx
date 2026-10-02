"use client";

import { parseDate } from "@internationalized/date";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { useState } from "react";
import { Button } from "react-aria-components/Button";
import {
  Calendar,
  CalendarCell,
  CalendarGrid,
  CalendarGridBody,
  CalendarGridHeader,
  CalendarHeaderCell
} from "react-aria-components/Calendar";
import { Dialog, DialogTrigger } from "react-aria-components/Dialog";
import { Heading } from "react-aria-components/Heading";
import { Popover } from "react-aria-components/Popover";

import styles from "./alert-date-picker.module.css";

function calendarDate(value: string) {
  try {
    return parseDate(value);
  } catch {
    return null;
  }
}

export function AlertDatePicker({
  id,
  value,
  min,
  isInvalid,
  describedBy,
  onChange
}: {
  id: string;
  value: string;
  min: string;
  isInvalid?: boolean;
  describedBy?: string;
  onChange: (value: string) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const selected = calendarDate(value);
  const minimum = calendarDate(min) ?? undefined;

  return (
    <DialogTrigger isOpen={isOpen} onOpenChange={setIsOpen}>
      <div className={styles.control}>
        <input
          aria-describedby={describedBy}
          aria-invalid={isInvalid}
          id={id}
          min={min}
          onBlur={(event) => onChange(event.currentTarget.value)}
          onChange={(event) => onChange(event.currentTarget.value)}
          onInput={(event) => onChange(event.currentTarget.value)}
          type="date"
          value={value}
        />
        <Button
          aria-label="Choose alert date"
          className={styles.trigger}
          type="button"
        >
          <CalendarDays aria-hidden="true" size={19} />
        </Button>
      </div>
      <Popover className={styles.popover} offset={12} placement="bottom end">
        <Dialog aria-label="Choose alert date" className={styles.dialog}>
          <Calendar
            aria-label="Alert date"
            autoFocus
            className={styles.calendar}
            defaultFocusedValue={
              selected && (!minimum || selected.compare(minimum) >= 0)
                ? selected
                : minimum
            }
            minValue={minimum}
            onChange={(date) => {
              // A calendar date stays YYYY-MM-DD; never convert it through UTC.
              onChange(date.toString());
              setIsOpen(false);
            }}
            value={selected}
          >
            <header className={styles.header}>
              <Button className={styles.navigation} slot="previous" type="button">
                <ChevronLeft aria-hidden="true" size={19} />
              </Button>
              <Heading className={styles.heading} />
              <Button className={styles.navigation} slot="next" type="button">
                <ChevronRight aria-hidden="true" size={19} />
              </Button>
            </header>
            <CalendarGrid className={styles.grid} weekdayStyle="short">
              <CalendarGridHeader>
                {(day) => (
                  <CalendarHeaderCell className={styles.weekday}>
                    {day}
                  </CalendarHeaderCell>
                )}
              </CalendarGridHeader>
              <CalendarGridBody>
                {(date) => <CalendarCell className={styles.day} date={date} />}
              </CalendarGridBody>
            </CalendarGrid>
          </Calendar>
          <p className={styles.help}>Choose a future date for your alert.</p>
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}
